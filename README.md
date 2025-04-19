# mcp-mysql-server

A MySQL database operation server based on the Model Context Protocol. This server enables AI models to interact with MySQL databases through a standardized interface.

## Installation

```bash
npx @marcostalder85/mcp-mysql-server
```

## Configuration

The server supports two deployment modes:

### 1. Local Run Mode

Run using the command line in the MCP settings configuration file:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "@marcostalder85/mcp-mysql-server"],
      "env": {
        "MYSQL_HOST": "your_host",
        "MYSQL_USER": "your_user",
        "MYSQL_PASSWORD": "your_password",
        "MYSQL_DATABASE": "your_database",
        "MYSQL_PORT": "3306"
        "MYSQL_SOCKET": "your_socket"  // Optional, for socket connections
      }
    }
  }
}
```

### 2. Remote URL Mode (v0.2.2+)

Point to a remotely running MCP server:

```json
{
  "mcpServers": {
    "mcp-mysql-server": {
      "url": "http://your-server-address:port/mcp-mysql-server"
    }
  }
}
```

On the remote server, you need to set environment variables before starting the MCP server:

```bash
# Set environment variables
export MYSQL_HOST=your_host
export MYSQL_USER=your_user
export MYSQL_PASSWORD=your_password
export MYSQL_DATABASE=your_database
export MYSQL_PORT=3306  # Optional, defaults to 3306
export MYSQL_SOCKET=your_socket  # Optional, for socket connections

# Start the server
npx @marcostalder85/mcp-mysql-server
```

> Note: MYSQL_PORT is optional and defaults to 3306.

## Version Features

### v0.2.5+ New Features
- **Connection via socket**: Added support for socket connections to the MySQL database.

### v0.2.4+ New Features
- **Multi-user concurrency support**: The server can now handle requests from multiple users simultaneously.
- **Efficient connection pool management**: Improved connection pool supports up to 50 concurrent connections.
- **Request-level isolation**: Each request has a unique identifier for easier tracking and debugging.
- **Detailed logging**: Logs the execution process and resource usage of each request.
- **Improved error handling**: More precise capture and reporting of database errors.
- **Performance optimization**: Connection pool reuse and optimized connection management improve processing speed.

### v0.2.2+ Features
- **Automatic database connection**: Automatically attempts to connect to the database at server startup if environment variables are set.
- **No client parameters required**: When using URL mode, the client does not need to provide database connection information.
- **Transparent database operations**: Tools like `list_tables` and `query` can be used directly without first calling `connect_db`.
- **More secure**: Sensitive database credentials exist only on the server side and are not exposed in client conversations.
- **Graceful fault tolerance**: Even if the initial connection fails, subsequent operations will automatically retry the connection.

## Available Tools

### 1. connect_db
Establish a connection to the MySQL database using the provided credentials. This tool is optional if the connection is already set via environment variables.

```json
{
  "host": "localhost",
  "user": "root",
  "password": "your_password",
  "database": "your_database",
  "port": 3306  // Optional, defaults to 3306
  "socket": "your_socket"  // Optional, for socket connections
}
```

### 2. query
Execute a SELECT query, supporting optional prepared statement parameters.

```json
{
  "sql": "SELECT * FROM users WHERE id = ?",
  "params": [1]  // Optional parameters
}
```

### 3. list_tables
List all tables in the connected database.

```json
{}  // No parameters required starting from v0.2.4
```

### 4. describe_table
Get the structure of a specific table.

```json
{
  "table": "users"
}
```

## Features

- Secure connection handling with automatic cleanup
- Support for prepared statement parameters
- Comprehensive error handling and validation
- TypeScript support
- Automatic connection management
- Server environment variable configuration
- Support for URL remote connection mode
- Multi-user concurrency support
- High-performance connection pool

## Performance

- Supports up to 50 concurrent connections (configurable)
- Automatic connection pool management for better resource utilization
- Detailed request tracking and performance monitoring

## Security

- Prevents SQL injection using prepared statements
- Secure password handling via environment variables
- Validates queries before execution
- Automatically closes connections after completion
- Sensitive credentials are not exposed in client conversations in URL mode
- Connection isolation to prevent data leakage between users

## Contribution

Contributions are welcome! Feel free to submit a Pull Request to https://github.com/marcostalder85/mcp-mysql-server.git

## License

MIT