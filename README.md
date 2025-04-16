# mcp-mysql-server

一个基于Model Context Protocol的MySQL数据库操作服务器。该服务器使AI模型能够通过标准化接口与MySQL数据库进行交互。

## 安装

```bash
npx @malove86/mcp-mysql-server
```

## 配置

服务器需要在MCP设置配置文件中设置以下环境变量：

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "@malove86/mcp-mysql-server"],
      "env": {
        "MYSQL_HOST": "your_host",
        "MYSQL_USER": "your_user",
        "MYSQL_PASSWORD": "your_password",
        "MYSQL_DATABASE": "your_database"
      }
    }
  }
}
```

## 可用工具

### 1. connect_db
使用提供的凭据建立与MySQL数据库的连接。

### 2. query
执行SELECT查询，支持可选的预处理语句参数。

### 3. list_tables
列出已连接数据库中的所有表。

### 4. describe_table
获取特定表的结构。

## 功能特点

- 安全的连接处理，自动清理
- 支持预处理语句参数
- 全面的错误处理和验证
- TypeScript支持
- 自动连接管理

## 安全性

- 使用预处理语句防止SQL注入
- 通过环境变量支持安全密码处理
- 执行前验证查询
- 完成后自动关闭连接

## 贡献

欢迎贡献！请随时提交Pull Request到 https://github.com/Malove86/mcp-mysql-server.git

## 许可证

MIT 