/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import { sendMessage, sendMessageStream, listModels, getModelQuotas } from './cloudcode-client.js';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager.js';
import { ModelAggregator } from './model-aggregator.js';
import { formatDuration } from './utils/helpers.js';
import { authenticateUser } from './middleware/auth.js';

const app = express();

// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

// Initialize model aggregator for virtual model resolution
const modelAggregator = new ModelAggregator();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize();
            isInitialized = true;
            console.log('[Server] Account pool initialized with SQLite');
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            console.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Apply authentication middleware to all routes (except health which is handled inside authenticateUser)
app.use(authenticateUser);

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED') || error.message.includes('AUTH_INVALID')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure your account is properly configured and tokens are valid.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';  // Use invalid_request_error to force client to purge/stop
        statusCode = 400;  // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after (\d+h\d+m\d+s|\d+m\d+s|\d+s)/i);
        const modelMatch = error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check your upstream connection.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your project access.';
    }

    return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req, res, next) => {
    const userEmail = req.user ? req.user.email : 'anonymous';
    console.log(`[${new Date().toISOString()}] ${userEmail} - ${req.method} ${req.path}`);
    next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 */
app.get('/account-limits', async (req, res) => {
    try {
        await ensureInitialized();
        const userId = req.user.id;
        const allAccounts = accountManager.getAccounts(userId);
        const format = req.query.format || 'json';

        if (allAccounts.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'No accounts found for this user. Add accounts using "npm run accounts:add".'
            });
        }

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
            allAccounts.map(async (account) => {
                // Skip invalid accounts
                if (account.is_invalid) {
                    return {
                        email: account.email,
                        status: 'invalid',
                        error: account.invalid_reason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const quotas = await getModelQuotas(token);

                    return {
                        email: account.email,
                        status: 'ok',
                        models: quotas
                    };
                } catch (error) {
                    return {
                        email: account.email,
                        status: 'error',
                        error: error.message,
                        models: {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    email: allAccounts[index].email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {}
                };
            }
        });

        // Collect all unique model IDs
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits for ${req.user.email} (${timestamp})`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 30;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (let i = 0; i < allAccounts.length; i++) {
                const acc = allAccounts[i];
                const shortEmail = acc.email.length > (accColWidth - 3) ? acc.email.slice(0, accColWidth - 6) + '...' : acc.email;
                const lastUsed = acc.last_used ? new Date(acc.last_used).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.is_invalid) {
                    accStatus = 'invalid';
                } else if (acc.is_rate_limited) {
                    const remaining = acc.rate_limit_reset_time ? acc.rate_limit_reset_time - Date.now() : 0;
                    accStatus = remaining > 0 ? `limited (${formatDuration(remaining)})` : 'rate-limited';
                } else {
                    accStatus = accLimit?.status || 'ok';
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths for models table
            const modelColWidth = Math.max(25, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 22;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 18);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = modelId.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    let cell;
                    if (acc.status !== 'ok') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === null) {
                        cell = '0% (exhausted)';
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Default: JSON format
        res.json({
            timestamp: new Date().toLocaleString(),
            user: req.user.email,
            totalAccounts: allAccounts.length,
            models: sortedModels,
            accounts: accountLimits.map(acc => ({
                email: acc.email,
                status: acc.status,
                error: acc.error || null,
                limits: Object.fromEntries(
                    sortedModels.map(modelId => {
                        const quota = acc.models?.[modelId];
                        if (!quota) {
                            return [modelId, null];
                        }
                        return [modelId, {
                            remaining: quota.remainingFraction !== null
                                ? `${Math.round(quota.remainingFraction * 100)}%`
                                : 'N/A',
                            remainingFraction: quota.remainingFraction,
                            resetTime: quota.resetTime || null
                        }];
                    })
                )
            }))
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const account = accountManager.pickNext(req.user.id);
        if (!account) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No accounts available for your user. Please add accounts or wait for rate limits to reset.'
                }
            });
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        res.json(models);
    } catch (error) {
        console.error('[API] Error listing models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
        });
    }
});

/**
 * Count tokens endpoint (not supported)
 */
app.post('/v1/messages/count_tokens', (req, res) => {
    res.status(501).json({
        type: 'error',
        error: {
            type: 'not_implemented',
            message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
        }
    });
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */
app.post('/v1/messages', async (req, res) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        const {
            model,
            messages,
            max_tokens,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        const requestedModel = model || 'claude-3-5-sonnet-20241022';

        // Resolve virtual model to candidate list
        const candidateModels = modelAggregator.resolve(req.user.id, requestedModel);
        const isVirtualModel = candidateModels.length > 1 || candidateModels[0] !== requestedModel;

        if (isVirtualModel) {
            console.log(`[Aggregator] User ${req.user.username} requesting '${requestedModel}' -> candidates: [${candidateModels.join(', ')}]`);
        }

        let lastError = null;
        let success = false;

        // Try each candidate model
        for (const candidateModel of candidateModels) {
            // Build the request object with current candidate model
            const request = {
                model: candidateModel,
                messages,
                max_tokens: max_tokens || 4096,
                stream,
                system,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            };

            if (isVirtualModel) {
                console.log(`[Aggregator] Trying model '${candidateModel}'...`);
            } else {
                console.log(`[API] Request from ${req.user.email} for model: ${request.model}, stream: ${!!stream}`);
            }

            try {
                if (stream) {
                    // Handle streaming response
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.setHeader('X-Accel-Buffering', 'no');

                    // Flush headers immediately to start the stream
                    if (res.flushHeaders) res.flushHeaders();

                    try {
                        // Use the streaming generator with account manager and user ID
                        for await (const event of sendMessageStream(request, accountManager, req.user.id)) {
                            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                            // Flush after each event for real-time streaming
                            if (res.flush) res.flush();
                        }
                        res.end();
                        success = true;
                        break;

                    } catch (streamError) {
                        // Check if this is a rate limit error that should trigger failover
                        if (modelAggregator.isRateLimitError(streamError) && candidateModels.indexOf(candidateModel) < candidateModels.length - 1) {
                            console.warn(`[Aggregator] Model '${candidateModel}' rate limited. Failover to next candidate...`);
                            lastError = streamError;
                            // Note: For streaming, we may have already sent headers
                            // If headers were sent, we can't failover - need to report error via SSE
                            if (res.headersSent) {
                                // Can't failover after streaming has started
                                const { errorType, errorMessage } = parseError(streamError);
                                res.write(`event: error\ndata: ${JSON.stringify({
                                    type: 'error',
                                    error: { type: errorType, message: errorMessage }
                                })}\n\n`);
                                res.end();
                                return;
                            }
                            continue;
                        }

                        console.error('[API] Stream error:', streamError);
                        const { errorType, errorMessage } = parseError(streamError);
                        res.write(`event: error\ndata: ${JSON.stringify({
                            type: 'error',
                            error: { type: errorType, message: errorMessage }
                        })}\n\n`);
                        res.end();
                        return;
                    }

                } else {
                    // Handle non-streaming response
                    const response = await sendMessage(request, accountManager, req.user.id);
                    res.json(response);
                    success = true;
                    break;
                }

            } catch (error) {
                lastError = error;

                // Check if this is a rate limit error that should trigger failover
                if (modelAggregator.isRateLimitError(error) && candidateModels.indexOf(candidateModel) < candidateModels.length - 1) {
                    console.warn(`[Aggregator] Model '${candidateModel}' rate limited. Failover to next candidate...`);
                    continue;
                }

                // For other errors, throw immediately
                throw error;
            }
        }

        // If all candidates failed
        if (!success && lastError) {
            console.error(`[Aggregator] All candidates for '${requestedModel}' failed.`);
            throw lastError;
        }

    } catch (error) {
        console.error('[API] Error:', error);

        const { errorType, statusCode, errorMessage } = parseError(error);

        console.log(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            console.log('[API] Headers already sent, writing error as SSE event');
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    }
});

/**
 * Catch-all for unsupported endpoints
 */
app.use('*', (req, res) => {
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;
