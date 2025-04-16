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
    if (!this.config) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Database configuration not set. Use connect_db tool first.'
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
          description: 'Connect to MySQL database',
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
            properties: {},
            required: [],
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

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    const sql = args.sql.trim();

    if (!sql.toUpperCase().startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only SELECT queries are allowed with query tool'
      );
    }

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
  }
}

const server = new MySQLServer();
server.run().catch(console.error);
