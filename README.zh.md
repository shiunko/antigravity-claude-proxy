# Antigravity Claude Proxy

[English](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 特别鸣谢

本项目是 [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy) 的 Fork 版本。非常感谢原作者的工作！

这是一个代理服务器，它通过 **Antigravity's Cloud Code** 后端暴露 **Anthropic 兼容 API**，让你可以通过 **Claude Code CLI** 使用 Claude 和 Gemini 模型。

![Antigravity Claude Proxy Banner](images/banner.png)

## 工作原理

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│     本代理服务器      │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. 接收 **Anthropic Messages API 格式** 的请求
2. 使用已添加 Google 账号的 OAuth 令牌
3. 转换为 Cloud Code 封装的 **Google Generative AI 格式**
4. 发送到 Antigravity 的 Cloud Code API
5. 将响应转换回 **Anthropic 格式**，支持完整的思考（thinking）和流式传输（streaming）

## 先决条件

- **mise** (https://mise.jdx.dev)
- 用于认证的 **Google 账号**

---

## 安装

```bash
git clone https://github.com/shiunko/antigravity-claude-proxy.git
cd antigravity-claude-proxy

# 安装工具 (Node.js)
mise install

# 信任项目以允许环境配置加载
mise trust

# 安装依赖 (运行 npm install)
mise run init
```

---

## 快速开始

### 1. 添加账号

添加一个或多个 Google 账号以进行负载均衡：

```bash
npm run accounts:add
```

这将在浏览器中打开 Google OAuth 页面。登录并授权访问。重复此步骤以添加多个账号。

管理账号：

```bash
# 列出所有账号
npm run accounts:list

# 验证账号是否工作
npm run accounts:verify

# 交互式账号管理
npm run accounts
```

### 2. 启动代理服务器

```bash
mise run api
```

服务器默认运行在 `http://localhost:8080`。

要在不同端口（例如 3000）上运行：

```bash
PORT=3000 mise run api
```

### 3. 启动 Web 管理面板（可选但推荐）

本项目现在包含一个功能齐全的 Web 管理面板，用于管理账号、用户和模型组。

```bash
# 启动管理面板
mise run ui
```

管理面板默认运行在 `http://localhost:3000`。

功能特性：
- **可视化账号管理**：通过 OAuth 或手动输入添加/移除 Google 账号
- **配额跟踪**：实时查看剩余配额和重置时间
- **模型组**：创建和管理虚拟模型别名，支持拖拽排序
- **用户管理**：管理 API 密钥和用户访问权限
- **统计概览**：监控代理运行状况和使用情况

### 4. 验证是否工作

```bash
# 健康检查
curl http://localhost:8080/health

# 检查账号状态和配额限制
curl "http://localhost:8080/account-limits?format=table"
```

---

## Web 管理面板

新的管理面板 (`http://localhost:3000`) 为所有管理任务提供了图形化界面。

### 主要功能

1.  **账号管理**
    - 添加多个 Google 账号以进行负载均衡
    - 查看健康状态（活跃/限速/无效）
    - 查看每个模型的精确配额使用情况
    - 重新认证无效账号

2.  **模型组（虚拟别名）**
    - 创建虚拟模型（例如 `company-pro`）
    - 定义故障转移策略（优先级 vs 随机）
    - 拖拽调整模型优先级
    - 直接在 UI 中测试模型组

3.  **用户管理**
    - 创建和管理团队成员
    - 生成和撤销 API 密钥
    - 授予管理员权限

## 用户管理 (CLI)

代理服务器支持多个客户端用户，每个用户都有自己的 API 密钥。这对于在团队中共享单个代理实例并跟踪每个用户的使用情况非常有用。

```bash
# 创建新用户
npm run users create <username>
# 输出:
# Username: alice
# API Key:  sk-proxy-... (与用户共享此密钥)

# 列出所有用户
npm run users list

# 删除用户
npm run users delete <username>
```

**注意：** 用户应在其 [Claude Code 配置](#在-claude-code-cli-中使用) 中使用生成的 API 密钥作为 `ANTHROPIC_API_KEY`。

---

## 模型组（虚拟模型别名）

模型组允许你创建映射到多个实际模型的虚拟模型别名。当收到虚拟模型的请求时，代理会按顺序尝试每个配置的模型，直到有一个成功。这对以下场景非常有用：

- **故障转移 (Failover)**：当主模型被限速时，自动回退到备用模型
- **负载均衡 (Load Balancing)**：使用随机选择在多个模型之间分配请求

### 创建模型组

```bash
# 创建优先级策略的模型组（按顺序故障转移）
npm run users group:create <username> <alias> priority

# 创建随机策略的模型组（负载均衡）
npm run users group:create <username> <alias> random
```

### 向组中添加模型

```bash
# 添加带优先级顺序的模型（数字越小优先级越高）
npm run users group:add <username> <alias> <model-name> <order>

# 示例：创建一个 "think-high" 组，Claude 作为主模型，Gemini 作为备用
npm run users group:create alice think-high priority
npm run users group:add alice think-high claude-opus-4-5-thinking 0
npm run users group:add alice think-high gemini-2.5-pro 1
```

### 管理模型组

```bash
# 列出用户的所有模型组
npm run users group:list <username>

# 从组中移除模型
npm run users group:remove <username> <alias> <model-name>

# 删除模型组
npm run users group:delete <username> <alias>
```

### 使用虚拟模型

配置完成后，在 Claude Code 设置中使用虚拟模型别名：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-proxy-...",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "think-high"
  }
}
```

当收到 `think-high` 的请求时：
1. 代理首先尝试 `claude-opus-4-5-thinking`
2. 如果被限速（429），自动故障转移到 `gemini-2.5-pro`

---

## 在 Claude Code CLI 中使用

### 配置 Claude Code

创建或编辑 Claude Code 设置文件：

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

添加以下配置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

或者使用 Gemini 模型：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-2.5-flash-lite",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-flash"
  }
}
```

### 加载环境变量

将代理设置添加到你的 shell 配置文件中：

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="test"' >> ~/.zshrc
source ~/.zshrc
```

> Bash 用户请将 `~/.zshrc` 替换为 `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8080'"
Add-Content $PROFILE "`$env:ANTHROPIC_API_KEY = 'test'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8080"
setx ANTHROPIC_API_KEY "test"
```

重启终端以使更改生效。

### 运行 Claude Code

```bash
# 确保先启动代理
antigravity-claude-proxy start

# 在另一个终端中运行 Claude Code
claude
```

> **注意：** 如果 Claude Code 要求你选择登录方式，请在 `~/.claude.json` (macOS/Linux) 或 `%USERPROFILE%\.claude.json` (Windows) 中添加 `"hasCompletedOnboarding": true`，然后重启终端重试。

---

## 可用模型

### Claude 模型

| 模型 ID | 描述 |
|----------|-------------|
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 (带扩展思考) |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 (带扩展思考) |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 (无思考) |

### Gemini 模型

| 模型 ID | 描述 |
|----------|-------------|
| `gemini-3-flash` | Gemini 3 Flash (带思考) |
| `gemini-3-pro-low` | Gemini 3 Pro Low (带思考) |
| `gemini-3-pro-high` | Gemini 3 Pro High (带思考) |

Gemini 模型包含完整的思考支持，并处理多轮对话中的 `thoughtSignature`。

---

## 多账号负载均衡

当你添加多个账号时，代理会自动：

- **粘性账号选择**：保持在同一账号上以最大化提示缓存（prompt cache）命中率
- **智能速率限制处理**：对于短时间的速率限制（≤2分钟）进行等待，对于更长时间的限制则切换账号
- **自动冷却**：受限账号在重置时间过后自动恢复可用
- **无效账号检测**：需要重新认证的账号会被标记并跳过
- **提示缓存支持**：稳定的会话 ID 确保跨对话轮次的缓存命中

随时检查账号状态：

```bash
curl "http://localhost:8080/account-limits?format=table"
```

---

## 数据持久化

所有配置数据（用户、账号、模型组）都存储在位于 `data/proxy.db` 的本地 SQLite 数据库中。

-   **备份**：你可以备份 `data/` 目录以保存你的配置。
-   **迁移**：如果你将代理移动到新机器，请复制 `data/` 文件夹以保留你的账号和用户。

## API 端点

| 端点 | 方法 | 描述 |
|----------|--------|-------------|
| `/health` | GET | 健康检查 |
| `/account-limits` | GET | 账号状态和配额限制 (添加 `?format=table` 以获取 ASCII 表格) |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | 列出可用模型 |
| `/refresh-token` | POST | 强制刷新令牌 |

---

## 测试

运行测试套件（需要服务器正在运行）：

```bash
# 在一个终端启动服务器
mise run api

# 在另一个终端运行测试
npm test
```

运行单个测试：

```bash
npm run test:signatures    # 思考签名 (Thinking signatures)
npm run test:multiturn     # 带工具的多轮对话
npm run test:streaming     # 流式 SSE 事件
npm run test:interleaved   # 交错思考 (Interleaved thinking)
npm run test:images        # 图像处理
npm run test:caching       # 提示缓存 (Prompt caching)
```

---

## 故障排除

### 401 认证错误 (Authentication Errors)

令牌可能已过期。尝试：
```bash
curl -X POST http://localhost:8080/refresh-token
```

或者重新认证账号：
### 账号显示 "Invalid" (无效)

重新认证账号：
```bash
npm run accounts
# 选择 "Re-authenticate" 来重新认证无效账号
```

---

## 安全、使用和风险提示

### 预期用途

- 仅限个人/内部开发使用
- 遵守内部配额和数据处理政策
- 不用于生产服务或绕过预期限制

### 不适用于

- 生产应用程序流量
- 大量自动提取
- 任何违反可接受使用政策（Acceptable Use Policies）的用途

### 警告（风险承担）

通过使用本软件，您承认并接受以下内容：

- **服务条款风险**：此方法可能违反 AI 模型提供商（Anthropic, Google 等）的服务条款。您全权负责确保遵守所有适用的条款和政策。

- **账号风险**：提供商可能会检测到这种使用模式并采取惩罚措施，包括暂停、永久封禁或失去付费订阅的访问权限。

- **无保证**：提供商可能随时更改 API、认证或政策，这可能会在没有通知的情况下破坏此方法。

- **风险承担**：您承担所有法律、财务和技术风险。本项目的作者和贡献者对因您使用而产生的任何后果不承担任何责任。

**使用风险自负。仅在您理解并接受这些风险的情况下继续。**

---

## 法律声明

- **不隶属于 Google 或 Anthropic。** 这是一个独立的开源项目，未获 Google LLC 或 Anthropic PBC 的认可、赞助或附属。

- "Antigravity", "Gemini", "Google Cloud", 和 "Google" 是 Google LLC 的商标。

- "Claude" 和 "Anthropic" 是 Anthropic PBC 的商标。

- 软件按“原样”提供，不作任何保证。您负责遵守所有适用的服务条款和可接受使用政策。

---

## 致谢

本项目基于以下项目的见解和代码：

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - OpenCode 的 Antigravity OAuth 插件
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - 使用 LiteLLM 的 Anthropic API 代理

---

## 许可证

MIT

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=shiunko/antigravity-claude-proxy&type=date&legend=top-left)](https://www.star-history.com/#shiunko/antigravity-claude-proxy&type=date&legend=top-left)
