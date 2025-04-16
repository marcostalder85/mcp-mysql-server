#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { Pool } from 'mysql2/promise';

// Load environment variables
config();

interface DatabaseConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number; // Add optional port parameter
}

// Type guard for error objects
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// Helper to get error message
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Helper to validate SQL query for basic security
function validateSqlQuery(sql: string): boolean {
  // 检查是否存在常见SQL注入模式
  const dangerousPatterns = [
    /;\s*DROP\s+/i,
    /;\s*DELETE\s+/i,
    /;\s*UPDATE\s+/i,
    /;\s*INSERT\s+/i,
    /UNION\s+SELECT/i,
    /--/,
    /\/\*/,
    /xp_cmdshell/i
  ];

  return !dangerousPatterns.some(pattern => pattern.test(sql));
}

class MySQLServer {
  private server: Server;
  private connection: mysql.Connection | null = null;
  private pool: Pool | null = null;
  private config: DatabaseConfig | null = null;
  private autoConnected: boolean = false;

  constructor() {
    this.server = new Server(
      {
        name: 'mysql-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    if (process.env.MYSQL_HOST
      && process.env.MYSQL_USER
      && process.env.MYSQL_PASSWORD !== undefined
      && process.env.MYSQL_PASSWORD !== null
      && process.env.MYSQL_DATABASE) {
      this.config = {
        host: process.env.MYSQL_HOST as string,
        user: process.env.MYSQL_USER as string,
        password: process.env.MYSQL_PASSWORD as string,
        database: process.env.MYSQL_DATABASE as string,
        port: Number(process.env.MYSQL_PORT ?? 3306),
      };

      // 打印连接信息
      console.error(`[Init] Found database configuration in environment variables: ${this.config.host}:${this.config.port}/${this.config.database}`);
    }

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    if (this.connection) {
      await this.connection.end();
    }
    if (this.pool) {
      await this.pool.end();
    }
    await this.server.close();
  }

  private async ensureConnection() {
    // 如果没有配置，抛出错误
    if (!this.config) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Database configuration not set. Use connect_db tool first or set environment variables.'
      );
    }

    // 创建连接池
    if (!this.pool) {
      try {
        // 创建连接池而不是单一连接，提高性能和稳定性
        this.pool = mysql.createPool({
          ...this.config,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0
        });

        // 测试连接池是否正常工作
        const conn = await this.pool.getConnection();
        await conn.ping();
        conn.release();

        console.error(`Successfully connected to MySQL database: ${this.config.host}:${this.config.port || 3306}/${this.config.database}`);
        this.autoConnected = true;
      } catch (error) {
        this.pool = null; // 重置连接池对象以便下次重试
        const errorMsg = getErrorMessage(error);
        console.error(`Database connection failed: ${errorMsg}`);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${errorMsg}`
        );
      }
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect_db',
          description: 'Connect to MySQL database (optional if environment variables are set)',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Database host',
              },
              user: {
                type: 'string',
                description: 'Database user',
              },
              password: {
                type: 'string',
                description: 'Database password',
              },
              database: {
                type: 'string',
                description: 'Database name',
              },
              port: {
                type: 'number',
                description: 'Database port (optional)',
              },
            },
            required: ['host', 'user', 'password', 'database'],
          },
        },
        {
          name: 'query',
          description: 'Execute a SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL SELECT query',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'list_tables',
          description: 'List all tables in the database',
          inputSchema: {
            type: 'object',
            properties: {
              random_string: {
                type: 'string',
                description: 'Dummy parameter for no-parameter tools',
              }
            },
            required: ['random_string'],
          },
        },
        {
          name: 'describe_table',
          description: 'Get table structure',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
            },
            required: ['table'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // 如果有环境变量配置并且不是connect_db命令，先确保连接存在
      if (this.config && !this.autoConnected && request.params.name !== 'connect_db') {
        try {
          await this.ensureConnection();
          this.autoConnected = true;
        } catch (error) {
          console.error(`Auto-connection failed: ${getErrorMessage(error)}`);
          // 不抛出错误，让后续操作根据实际情况处理
        }
      }

      switch (request.params.name) {
        case 'connect_db':
          return await this.handleConnectDb(request.params.arguments);
        case 'query':
          return await this.handleQuery(request.params.arguments);
        case 'list_tables':
          return await this.handleListTables();
        case 'describe_table':
          return await this.handleDescribeTable(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleConnectDb(args: any) {
    // 验证参数
    if (!args.host || !args.user || args.password === undefined || args.password === null || !args.database) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing required database configuration parameters'
      );
    }

    // 关闭现有连接
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }

    // 关闭现有连接池
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }

    this.config = {
      host: args.host,
      user: args.user,
      password: args.password,
      database: args.database,
      port: args.port || 3306, // 确保有默认端口
    };

    try {
      await this.ensureConnection();
      this.autoConnected = true;
      return {
        content: [
          {
            type: 'text',
            text: 'Successfully connected to database',
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleQuery(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    if (!args.sql.trim().toUpperCase().startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only SELECT queries are allowed with query tool'
      );
    }

    const sql = args.sql.trim();

    // 验证SQL安全性
    if (!validateSqlQuery(sql)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'SQL query contains potentially dangerous patterns'
      );
    }

    try {
      const [rows] = await this.pool!.query(args.sql, args.params || []);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(`Query execution failed: ${errorMsg}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${errorMsg}`
      );
    }
  }

  private async handleListTables() {
    await this.ensureConnection();

    try {
      const [rows] = await this.pool!.query('SHOW TABLES');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleDescribeTable(args: any) {
    await this.ensureConnection();

    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    try {
      const [rows] = await this.pool!.query('DESCRIBE ??', [args.table]);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${getErrorMessage(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP server running on stdio');

    // 如果配置了环境变量，尝试初始连接
    if (this.config && !this.autoConnected) {
      try {
        await this.ensureConnection();
        console.error('[Init] Auto-connected to database with environment variables');
        this.autoConnected = true;
      } catch (error) {
        console.error(`[Init] Auto-connection failed: ${getErrorMessage(error)}`);
        // 不抛出错误，让后续操作根据实际情况处理
      }
    }
  }
}

const server = new MySQLServer();
server.run().catch(console.error);
