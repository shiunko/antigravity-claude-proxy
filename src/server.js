/**
 * Express Server - Unified Proxy
 * Orchestrates Anthropic and OpenAI compatible APIs
 * Proxies to Google Cloud Code via Antigravity
 */

import express from 'express';
import cors from 'cors';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './services/account-manager.js';
import { ModelAggregator } from './services/model-aggregator.js';
import { Orchestrator } from './core/orchestrator.js';
import { CloudCodeOutput } from './adapters/output/cloudcode-output.js';
import { AnthropicInput } from './adapters/input/anthropic-input.js';
import { OpenAIInput } from './adapters/input/openai-input.js';
import { authenticateUser } from './middleware/auth.js';
import { formatDuration } from './utils/helpers.js';

const app = express();

// 1. Initialize Services
// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

// Initialize model aggregator for virtual model resolution
const modelAggregator = new ModelAggregator();

// Initialize Orchestrator
const orchestrator = new Orchestrator(modelAggregator);

// 2. Initialize Adapters
// Output Adapter: CloudCode (Google Gemini)
const cloudCodeOutput = new CloudCodeOutput(accountManager);
orchestrator.registerAdapter('cloudcode', cloudCodeOutput, true); // Set as default

// Input Adapters
const anthropicInput = new AnthropicInput(orchestrator);
const openAIInput = new OpenAIInput(orchestrator);

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

// 3. Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Request logging middleware
app.use((req, res, next) => {
    const userEmail = req.user ? req.user.email : 'anonymous';
    // Don't log health checks to reduce noise if needed, but useful for debug
    if (req.path !== '/health') {
        console.log(`[${new Date().toISOString()}] ${userEmail} - ${req.method} ${req.path}`);
    }
    next();
});

// Apply authentication middleware to all routes (except health which checks internally if needed, but here we apply globally)
// Note: authenticateUser skips /health and /
app.use(authenticateUser);

// 4. Register Input Routes
// Registers /v1/messages
anthropicInput.register(app);
// Registers /v1/chat/completions
openAIInput.register(app);

// 5. Infrastructure & Helper Routes

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
 * List models endpoint (OpenAI/Anthropic compatible)
 * Both clients often use /v1/models
 */
app.get('/v1/models', async (req, res) => {
    try {
        await ensureInitialized();
        const models = await cloudCodeOutput.listModels(req.user.id);
        res.json(models);
    } catch (error) {
        console.error('[API] Error listing models:', error);
        res.status(500).json({
            object: 'error',
            error: {
                type: 'api_error',
                message: error.message
            }
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
                    const quotas = await cloudCodeOutput.getModelQuotas(token);

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
