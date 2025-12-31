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
This is a proxy server that exposes an Anthropic-compatible API but forwards requests to Antigravity's Cloud Code service (Gemini models). It translates between Anthropic Messages API format and Google Generative AI format.

**Request Flow**
1. **Claude Code CLI** sends Anthropic-formatted request to `src/server.js`
2. **Request Converter** (`src/format/request-converter.js`) transforms it to Google format
3. **Account Manager** (`src/account-manager.js`) selects an account (sticky session for caching)
4. **CloudCode Client** (`src/cloudcode-client.js`) sends request to Antigravity API
5. **Response Converter** (`src/format/response-converter.js`) transforms response back to Anthropic format (handling thinking blocks and streams)

**Key Components**
- **`src/server.js`**: Express server handling `/v1/messages`, `/health`, etc.
- **`src/account-manager.js`**: Manages multiple accounts, handles rate limits (429), and implements sticky sessions for prompt caching.
- **`src/db/proxy-db.js`**: SQLite database interface for storing users and accounts.
- **`src/format/`**:
  - `thinking-utils.js`: Handles "thinking" blocks, signature validation, and recovery from corrupted states.
  - `signature-cache.js`: Caches signatures to restore them when stripped by clients.
  - `schema-sanitizer.js`: Cleans JSON schemas for Gemini compatibility.
- **`src/oauth.js`**: Handles Google OAuth flows.
- **`src/constants.js`**: Centralized configuration (endpoints, models, headers).

**Data Flow Concepts**
- **Prompt Caching**: Uses a stable session ID (hash of first user message) to keep requests on the same account.
- **Thinking Blocks**: Gemini's `thought` parts are converted to Anthropic's `thinking` blocks. Signatures are preserved/cached to satisfy API requirements.
- **Model Families**: `claude-*` models use `signature`; `gemini-*` models use `thoughtSignature`.

## Code Style & Conventions

- **Imports**: Use ES modules (`import`/`export`).
- **Error Handling**: Use custom classes from `src/errors.js` (`RateLimitError`, `AuthError`, `ApiError`).
- **Async/Await**: Prefer async/await over raw promises.
- **File Access**: Use `fs/promises` for file operations.
- **Constants**: Define all configuration values (timeouts, models, headers) in `src/constants.js`.
- **Testing**: Tests are CommonJS (`.cjs`) and use a shared HTTP client helper (`tests/helpers/http-client.cjs`).
