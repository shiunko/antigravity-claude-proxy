# Antigravity Claude Proxy

[中文](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI**.

![Antigravity Claude Proxy Banner](images/banner.png)

## Acknowledgements

This project is a fork of [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy). Huge thanks to the original author for their work!

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Uses OAuth tokens from added Google accounts
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic format** with full thinking/streaming support

## Prerequisites

- **Node.js** 18 or later
- **Google account(s)** for authentication

---

## Installation

### Option 1: npm (Recommended)

```bash
# Run directly with npx (no install needed)
npx antigravity-claude-proxy start

# Or install globally
npm install -g antigravity-claude-proxy
antigravity-claude-proxy start
```

### Option 2: Clone Repository

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install
npm start
```

---

## Quick Start

### 1. Add Account(s)

Add one or more Google accounts for load balancing:

```bash
# If installed via npm
antigravity-claude-proxy accounts add

# If using npx
npx antigravity-claude-proxy accounts add

# If cloned locally
npm run accounts:add
```

This opens your browser for Google OAuth. Sign in and authorize access. Repeat for multiple accounts.

Manage accounts:

```bash
# List all accounts
antigravity-claude-proxy accounts list

# Verify accounts are working
antigravity-claude-proxy accounts verify

# Interactive account management
antigravity-claude-proxy accounts
```

### 2. Start the Proxy Server

```bash
# If installed via npm
antigravity-claude-proxy start

# If using npx
npx antigravity-claude-proxy start

# If cloned locally
npm start
```

The server runs on `http://localhost:8080` by default.

To run on a different port (e.g., 3000):

```bash
# Using env var
PORT=3000 antigravity-claude-proxy start

# Or with npm
PORT=3000 npm start
```

### 3. Start the Web Admin Dashboard (Optional but Recommended)

The project now includes a full-featured web dashboard for managing accounts, users, and model groups.

```bash
# Install admin dependencies (first time only)
npm run admin:install

# Start the admin UI
npm run admin
```

The admin dashboard runs on `http://localhost:3000` by default.

Features:
- **Visual Account Management**: Add/remove Google accounts via OAuth or manual entry
- **Quota Tracking**: Real-time view of remaining quotas and reset times
- **Model Groups**: Create and manage virtual model aliases with drag-and-drop ordering
- **User Management**: Manage API keys and user access
- **Stats Overview**: Monitor proxy health and usage

### 4. Verify It's Working

```bash
# Health check
curl http://localhost:8080/health

# Check account status and quota limits
curl "http://localhost:8080/account-limits?format=table"
```

---

## Admin Dashboard

The new Admin Dashboard (`http://localhost:3000`) provides a graphical interface for all management tasks.

### Key Features

1.  **Account Management**
    - Add multiple Google accounts for load balancing
    - View health status (Active/Rate Limited/Invalid)
    - See exact quota usage per model
    - Re-authenticate invalid accounts

2.  **Model Groups (Virtual Aliases)**
    - Create virtual models (e.g., `company-pro`)
    - Define failover strategies (Priority vs Random)
    - Drag-and-drop to reorder model priority
    - Test model groups directly from the UI

3.  **User Management**
    - Create and manage team members
    - Generate and revoke API keys
    - Grant admin privileges

## User Management (CLI)

The proxy supports multiple client users, each with their own API key. This is useful for sharing a single proxy instance among a team while tracking usage per user.

```bash
# Create a new user
npm run users create <username>
# Output:
# Username: alice
# API Key:  sk-proxy-... (Share this key with the user)

# List all users
npm run users list

# Delete a user
npm run users delete <username>
```

**Note:** The user should use their generated API Key as the `ANTHROPIC_API_KEY` in their [Claude Code configuration](#using-with-claude-code-cli).

---

## Model Groups (Virtual Model Aliases)

Model Groups allow you to create virtual model aliases that map to multiple actual models. When a request comes in for a virtual model, the proxy will try each configured model in order until one succeeds. This is useful for:

- **Failover**: Automatically fall back to backup models when the primary model is rate-limited
- **Load Balancing**: Distribute requests across multiple models using random selection

### Creating a Model Group

```bash
# Create a model group with priority strategy (failover in order)
npm run users group:create <username> <alias> priority

# Create a model group with random strategy (load balancing)
npm run users group:create <username> <alias> random
```

### Adding Models to a Group

```bash
# Add models with priority order (lower number = higher priority)
npm run users group:add <username> <alias> <model-name> <order>

# Example: Create a "think-high" group with Claude as primary and Gemini as backup
npm run users group:create alice think-high priority
npm run users group:add alice think-high claude-opus-4-5-thinking 0
npm run users group:add alice think-high gemini-2.5-pro 1
```

### Managing Model Groups

```bash
# List all model groups for a user
npm run users group:list <username>

# Remove a model from a group
npm run users group:remove <username> <alias> <model-name>

# Delete a model group
npm run users group:delete <username> <alias>
```

### Using Virtual Models

Once configured, use the virtual model alias in your Claude Code settings:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-proxy-...",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "think-high"
  }
}
```

When a request comes in for `think-high`:
1. The proxy first tries `claude-opus-4-5-thinking`
2. If rate-limited (429), it automatically fails over to `gemini-2.5-pro`

---

## Using with Claude Code CLI

### Configure Claude Code

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

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

Or to use Gemini models:

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

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="test"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

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

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first
antigravity-claude-proxy start

# In another terminal, run Claude Code
claude
```

> **Note:** If Claude Code asks you to select a login method, add `"hasCompletedOnboarding": true` to `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows), then restart your terminal and try again.

---

## Available Models

### Claude Models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with extended thinking |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 without thinking |

### Gemini Models

| Model ID | Description |
|----------|-------------|
| `gemini-3-flash` | Gemini 3 Flash with thinking |
| `gemini-3-pro-low` | Gemini 3 Pro Low with thinking |
| `gemini-3-pro-high` | Gemini 3 Pro High with thinking |

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

---

## Multi-Account Load Balancing

When you add multiple accounts, the proxy automatically:

- **Sticky account selection**: Stays on the same account to maximize prompt cache hits
- **Smart rate limit handling**: Waits for short rate limits (≤2 min), switches accounts for longer ones
- **Automatic cooldown**: Rate-limited accounts become available after reset time expires
- **Invalid account detection**: Accounts needing re-authentication are marked and skipped
- **Prompt caching support**: Stable session IDs enable cache hits across conversation turns

Check account status anytime:

```bash
curl "http://localhost:8080/account-limits?format=table"
```

---

## Data Persistence

All configuration data (users, accounts, model groups) is stored in a local SQLite database located at `data/proxy.db`.

-   **Backup**: You can back up the `data/` directory to preserve your configuration.
-   **Migration**: If you move the proxy to a new machine, copy the `data/` folder to keep your accounts and users.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/account-limits` | GET | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | List available models |
| `/refresh-token` | POST | Force token refresh |

---

## Testing

Run the test suite (requires server running):

```bash
# Start server in one terminal
npm start

# Run tests in another terminal
npm test
```

Individual tests:

```bash
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
```

---

## Troubleshooting

### 401 Authentication Errors

The token might have expired. Try:
```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate the account:
```bash
antigravity-claude-proxy accounts
```

### Rate Limiting (429)

With multiple accounts, the proxy automatically switches to the next available account. With a single account, you'll need to wait for the rate limit to reset.

### Account Shows as "Invalid"

Re-authenticate the account:
```bash
antigravity-claude-proxy accounts
# Choose "Re-authenticate" for the invalid account
```

---

## Safety, Usage, and Risk Notices

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Not Suitable For

- Production application traffic
- High-volume automated extraction
- Any use that violates Acceptable Use Policies

### Warning (Assumption of Risk)

By using this software, you acknowledge and accept the following:

- **Terms of Service risk**: This approach may violate the Terms of Service of AI model providers (Anthropic, Google, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.

- **Account risk**: Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.

- **No guarantees**: Providers may change APIs, authentication, or policies at any time, which can break this method without notice.

- **Assumption of risk**: You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

**Use at your own risk. Proceed only if you understand and accept these risks.**

---

## Legal

- **Not affiliated with Google or Anthropic.** This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC or Anthropic PBC.

- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

- "Claude" and "Anthropic" are trademarks of Anthropic PBC.

- Software is provided "as is", without warranty. You are responsible for complying with all applicable Terms of Service and Acceptable Use Policies.

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT