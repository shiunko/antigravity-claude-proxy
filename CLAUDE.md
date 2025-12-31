# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build/Install**: `npm install`
- **Start Server**: `npm start` (runs on port 8080)
- **Start (Dev)**: `npm run dev` (runs with file watching)
- **Accounts**:
  - Interactive: `npm run accounts`
  - Add: `npm run accounts:add`
  - List: `npm run accounts:list`
  - Verify: `npm run accounts:verify`
- **Users**:
  - Create: `npm run users create <username>`
  - List: `npm run users list`
  - Delete: `npm run users delete <username>`
- **Model Groups** (virtual model aliases with failover):
  - Create: `npm run users group:create <user> <alias> [strategy]`
  - Add model: `npm run users group:add <user> <alias> <model> [order]`
  - List: `npm run users group:list <user>`
  - Delete: `npm run users group:delete <user> <alias>`
  - Remove model: `npm run users group:remove <user> <alias> <model>`
- **Testing**:
  - **Prerequisite**: Server must be running (`npm start`) in a separate terminal.
  - Run all: `npm test`
  - Run specific: `node tests/run-all.cjs <filter>`
  - Signatures: `npm run test:signatures`
  - Multi-turn: `npm run test:multiturn`
  - Streaming: `npm run test:streaming`
  - Interleaved: `npm run test:interleaved`
  - Images: `npm run test:images`
  - Caching: `npm run test:caching`

## Architecture

**Overview**
This is a unified proxy server that exposes both **Anthropic-compatible** (`/v1/messages`) and **OpenAI-compatible** (`/v1/chat/completions`) APIs. It orchestrates requests through a central core and adapts them for Antigravity's Cloud Code service (Gemini models).

**Request Flow**
1. **Client** (Claude Code, Cursor, etc.) sends request to `src/server.js`
2. **Input Adapter** (`src/adapters/input/`) normalizes the request to a standard internal format
3. **Orchestrator** (`src/core/orchestrator.js`) routes the message, handling context management
4. **Account Manager** (`src/services/account-manager.js`) selects an upstream account (sticky sessions)
5. **Output Adapter** (`src/adapters/output/cloudcode-output.js`) converts to Google format and sends to Antigravity
6. **Response** is converted back to the client's expected format (handling streams and thinking blocks)

**Key Components**
- **`src/server.js`**: Express server entry point, wiring up adapters and middleware.
- **`src/core/orchestrator.js`**: Central hub that routes messages between inputs and outputs.
- **`src/adapters/`**:
  - **Input**: `anthropic-input.js`, `openai-input.js`
  - **Output**: `cloudcode-output.js` (Google Gemini)
- **`src/services/`**:
  - `account-manager.js`: Manages account pool, rate limits, and session stickiness.
  - `model-aggregator.js`: Resolves virtual model aliases with failover.
  - `database.js`: SQLite interface for persistence.
- **`src/utils/converters/`**:
  - `thinking-utils.js`: Handles thinking blocks and signature validation.
  - `signature-cache.js`: Caches signatures to restore them when stripped.
  - `schema-sanitizer.js`: Cleans JSON schemas for Gemini compatibility.

**Data Flow Concepts**
- **Unified Interface**: Clients see standard Anthropic or OpenAI APIs; the proxy handles translation.
- **Prompt Caching**: Uses a stable session ID to keep requests on the same upstream account.
- **Thinking Blocks**: Gemini's `thought` parts are preserved and converted to Anthropic `thinking` blocks.
- **Model Aggregation**: Virtual aliases (e.g., `gemini-2-pro`) map to actual models with `priority` or `random` failover.

## Code Style & Conventions

- **Imports**: Use ES modules (`import`/`export`).
- **Error Handling**: Use custom classes from `src/errors.js` (`RateLimitError`, `AuthError`, `ApiError`).
- **Async/Await**: Prefer async/await over raw promises.
- **File Access**: Use `fs/promises` for file operations.
- **Constants**: Define all configuration values (timeouts, models, headers) in `src/constants.js`.
- **Testing**: Tests are CommonJS (`.cjs`) and use a shared HTTP client helper (`tests/helpers/http-client.cjs`).
