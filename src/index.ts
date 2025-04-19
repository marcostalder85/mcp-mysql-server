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
  socketPath?: string; // Add optional socket path parameter
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
  private config: DatabaseConfig | null = null;
  private pool: Pool | null = null;
  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private activeConnections: number = 0;
  private maxConnections: number = 50; // 最大同时处理的连接数

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

      // Add socket path if provided in environment variables
      if (process.env.MYSQL_SOCKET) {
        this.config.socketPath = process.env.MYSQL_SOCKET;
      }

      // 打印连接信息
      console.error(`[Init] Found database configuration in environment variables: ${this.config.host}:${this.config.port}/${this.config.database}${this.config.socketPath ? ` (socket: ${this.config.socketPath})` : ''}`);
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
    if (this.pool) {
      try {
        console.error(`[Cleanup] Closing connection pool, active connections: ${this.activeConnections}`);
        await this.pool.end();
        console.error('[Cleanup] Connection pool closed successfully');
      } catch (error) {
        console.error(`[Cleanup] Error closing pool: ${getErrorMessage(error)}`);
      }
      this.pool = null;
    }
    await this.server.close();
  }

  private async ensureConnection() {
    // 如果已经有一个正在进行的连接操作，直接返回那个Promise
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // 如果没有配置，抛出错误
    if (!this.config) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Database configuration not set. Use connect_db tool first or set environment variables.'
      );
    }

    // 创建连接池
    if (!this.pool) {
      const connectionPromise = (async () => {
        try {
          // 创建连接池而不是单一连接，提高性能和稳定性
          this.pool = mysql.createPool({
            ...this.config,
            waitForConnections: true,
            connectionLimit: this.maxConnections,  // 增加连接池大小以支持更多同时连接
            queueLimit: 0
          });

          // 测试连接池是否正常工作
          const conn = await this.pool.getConnection();
          await conn.ping();
          conn.release();

          // 这里一定有config，因为前面已经检查过
          const config = this.config!;
          console.error(`Successfully connected to MySQL database: ${config.host}:${config.port || 3306}/${config.database}${config.socketPath ? ` (socket: ${config.socketPath})` : ''}`);
          this.isConnected = true;

          // 连接成功后清空connectionPromise，允许将来的连接检查创建新的Promise
          this.connectionPromise = null;
        } catch (error) {
          this.pool = null; // 重置连接池对象以便下次重试
          this.isConnected = false;
          this.connectionPromise = null; // 重置连接Promise

          const errorMsg = getErrorMessage(error);
          console.error(`Database connection failed: ${errorMsg}`);
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to connect to database: ${errorMsg}`
          );
        }
      })();

      this.connectionPromise = connectionPromise;
      return connectionPromise;
    }

    return Promise.resolve();
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
              socketPath: {
                type: 'string',
                description: 'MySQL Unix socket path (optional, overrides host and port)',
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
            required: [], // 修改为可选参数
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
      // 获取请求ID用于日志
      const requestId = `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      console.error(`[${requestId}] Received tool call: ${request.params.name}`);

      // 增加活跃连接计数
      this.activeConnections++;
      console.error(`[${requestId}] Active connections: ${this.activeConnections}`);

      try {
        // 如果有环境变量配置并且不是connect_db命令，先确保连接存在
        if (this.config && !this.isConnected && request.params.name !== 'connect_db') {
          try {
            console.error(`[${requestId}] Auto-connecting to database`);
            await this.ensureConnection();
          } catch (error) {
            console.error(`[${requestId}] Auto-connection failed: ${getErrorMessage(error)}`);
            // 不抛出错误，让后续操作根据实际情况处理
          }
        }

        let result;
        switch (request.params.name) {
          case 'connect_db':
            result = await this.handleConnectDb(requestId, request.params.arguments);
            break;
          case 'query':
            result = await this.handleQuery(requestId, request.params.arguments);
            break;
          case 'list_tables':
            result = await this.handleListTables(requestId);
            break;
          case 'describe_table':
            result = await this.handleDescribeTable(requestId, request.params.arguments);
            break;
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        return result;
      } finally {
        // 减少活跃连接计数
        this.activeConnections--;
        console.error(`[${requestId}] Request completed, active connections: ${this.activeConnections}`);
      }
    });
  }

  private async handleConnectDb(requestId: string, args: any) {
    // 验证参数
    if (!args.host || !args.user || args.password === undefined || args.password === null || !args.database) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing required database configuration parameters'
      );
    }

    // 关闭现有连接池
    if (this.pool) {
      try {
        console.error(`[${requestId}] Closing existing connection pool`);
        await this.pool.end();
      } catch (error) {
        console.error(`[${requestId}] Error closing pool: ${getErrorMessage(error)}`);
      }
      this.pool = null;
    }

    this.config = {
      host: args.host,
      user: args.user,
      password: args.password,
      database: args.database,
      port: args.port || 3306, // 确保有默认端口
    };

    if (args.socketPath) {
      this.config.socketPath = args.socketPath;
    }

    try {
      console.error(`[${requestId}] Connecting to database: ${this.config.host}:${this.config.port}/${this.config.database}${this.config.socketPath ? ` (socket: ${this.config.socketPath})` : ''}`);
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

  private async handleQuery(requestId: string, args: any) {
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
      console.error(`[${requestId}] Executing query: ${sql.substring(0, 100)}${sql.length > 100 ? '...' : ''}`);
      const [rows] = await this.pool!.query(args.sql, args.params || []);

      // 计算结果集大小
      const resultSize = JSON.stringify(rows).length;
      console.error(`[${requestId}] Query executed successfully, result size: ${resultSize} bytes`);

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
      console.error(`[${requestId}] Query execution failed: ${errorMsg}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${errorMsg}`
      );
    }
  }

  private async handleListTables(requestId: string) {
    await this.ensureConnection();

    try {
      console.error(`[${requestId}] Executing SHOW TABLES`);
      const [rows] = await this.pool!.query('SHOW TABLES');
      console.error(`[${requestId}] SHOW TABLES completed, found ${Array.isArray(rows) ? rows.length : 0} tables`);

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
      console.error(`[${requestId}] Failed to list tables: ${errorMsg}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${errorMsg}`
      );
    }
  }

  private async handleDescribeTable(requestId: string, args: any) {
    await this.ensureConnection();

    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    try {
      console.error(`[${requestId}] Executing DESCRIBE ${args.table}`);
      const [rows] = await this.pool!.query('DESCRIBE ??', [args.table]);
      console.error(`[${requestId}] DESCRIBE completed, found ${Array.isArray(rows) ? rows.length : 0} columns`);

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
      console.error(`[${requestId}] Failed to describe table: ${errorMsg}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${errorMsg}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP server running on stdio');
    console.error(`Max concurrent connections: ${this.maxConnections}`);

    // 如果配置了环境变量，尝试初始连接
    if (this.config && !this.isConnected) {
      try {
        console.error('[Init] Auto-connecting to database with environment variables');
        await this.ensureConnection();
        console.error('[Init] Auto-connection succeeded');
      } catch (error) {
        console.error(`[Init] Auto-connection failed: ${getErrorMessage(error)}`);
        // 不抛出错误，让后续操作根据实际情况处理
      }
    }
  }
}

const server = new MySQLServer();
server.run().catch(console.error);
