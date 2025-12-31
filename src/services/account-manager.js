/**
 * Account Manager
 * Manages multiple Antigravity accounts per user with sticky selection,
 * automatic failover, and smart cooldown for rate-limited accounts.
 *
 * Refactored to use SQLite (database.js) for multi-tenancy.
 */

import {
    getAccountsForUser,
    updateAccount,
    clearExpiredRateLimits
} from './database.js';

import {
    DEFAULT_COOLDOWN_MS,
    TOKEN_REFRESH_INTERVAL_MS,
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID,
    MAX_WAIT_BEFORE_ERROR_MS
} from '../constants.js';

import { refreshAccessToken } from './auth.js';
import { formatDuration } from '../utils/helpers.js';

export class AccountManager {
    // In-memory caches
    // Key: "userId:email" -> { token, extractedAt }
    #tokenCache = new Map();
    // Key: "userId:email" -> projectId
    #projectCache = new Map();

    constructor() {
        // Configuration is now in the DB
    }

    /**
     * Initialize the account manager
     * Clears expired rate limits in the DB on startup
     */
    async initialize() {
        try {
            const changes = clearExpiredRateLimits();
            if (changes.changes > 0) {
                console.log(`[AccountManager] Cleared ${changes.changes} expired rate limits on startup`);
            }
            console.log('[AccountManager] Initialized with SQLite database');
        } catch (error) {
            console.error('[AccountManager] Initialization warning:', error.message);
        }
    }

    /**
     * Get unique cache key for an account
     */
    #getCacheKey(account) {
        return `${account.user_id}:${account.email}`;
    }

    /**
     * Get accounts for a specific user
     */
    getAccounts(userId) {
        return getAccountsForUser(userId);
    }

    /**
     * Check if a user has any usable accounts
     */
    hasAvailableAccounts(userId) {
        const accounts = this.getAccounts(userId);
        return accounts.some(acc => !acc.is_rate_limited && !acc.is_invalid);
    }

    /**
     * Check if all accounts for a user are rate-limited
     */
    isAllRateLimited(userId) {
        const accounts = this.getAccounts(userId);
        if (accounts.length === 0) return true;
        return accounts.every(acc => acc.is_rate_limited);
    }

    /**
     * Pick an account with sticky selection preference for a specific user.
     * Prefers the most recently used account for cache continuity.
     *
     * @param {number} userId - The ID of the user
     * @returns {{account: Object|null, waitMs: number}}
     */
    pickStickyAccount(userId) {
        // Clear expired limits globally (or we could do it just for this user, but global is safer/easier)
        clearExpiredRateLimits();

        const accounts = this.getAccounts(userId);
        if (accounts.length === 0) {
            return { account: null, waitMs: 0 };
        }

        // Sort accounts:
        // 1. Most recently used first (descending last_used)
        // 2. Treat null last_used as 0
        accounts.sort((a, b) => (b.last_used || 0) - (a.last_used || 0));

        const currentSticky = accounts[0];

        // Case 1: Current sticky account is valid and ready
        if (currentSticky && !currentSticky.is_rate_limited && !currentSticky.is_invalid) {
            this.#touchAccount(currentSticky);
            return { account: currentSticky, waitMs: 0 };
        }

        // Case 2: Current sticky is rate-limited, check if we should wait
        if (currentSticky && currentSticky.is_rate_limited && currentSticky.rate_limit_reset_time) {
            const waitMs = currentSticky.rate_limit_reset_time - Date.now();
            if (waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
                console.log(`[AccountManager] User ${userId}: Waiting ${formatDuration(waitMs)} for sticky account: ${currentSticky.email}`);
                return { account: null, waitMs };
            }
        }

        // Case 3: Switch to next available account
        // Find first account that is not rate limited and not invalid
        const nextAccount = accounts.find(acc => !acc.is_rate_limited && !acc.is_invalid);

        if (nextAccount) {
            console.log(`[AccountManager] User ${userId}: Switched to account: ${nextAccount.email}`);
            this.#touchAccount(nextAccount);
            return { account: nextAccount, waitMs: 0 };
        }

        // Case 4: No accounts available
        return { account: null, waitMs: 0 };
    }

    /**
     * Pick next available account (fallback)
     */
    pickNext(userId) {
        const { account } = this.pickStickyAccount(userId);
        return account;
    }

    /**
     * Update usage timestamp
     */
    #touchAccount(account) {
        // Update last_used in DB
        updateAccount(account.id, { last_used: Date.now() });
        // Update local object for this request scope
        account.last_used = Date.now();
    }

    /**
     * Mark an account as rate-limited
     */
    markRateLimited(account, resetMs = null) {
        const cooldownMs = resetMs || DEFAULT_COOLDOWN_MS;
        const resetTime = Date.now() + cooldownMs;

        updateAccount(account.id, {
            is_rate_limited: 1, // SQLite uses 0/1
            rate_limit_reset_time: resetTime
        });

        console.log(
            `[AccountManager] Rate limited: ${account.email}. Available in ${formatDuration(cooldownMs)}`
        );
    }

    /**
     * Mark an account as invalid
     */
    markInvalid(account, reason = 'Unknown error') {
        updateAccount(account.id, {
            is_invalid: 1,
            invalid_reason: reason
        });

        console.log(`[AccountManager] ⚠ Account INVALID: ${account.email} (User: ${account.user_id})`);
        console.log(`[AccountManager]   Reason: ${reason}`);
    }

    /**
     * Get status for all accounts (admin view or debugging)
     * For multi-user, this might be expensive, so maybe restrict or paginate.
     * Keeping it simple for now: Returns ALL accounts across ALL users.
     */
    getStatus() {
        // TODO: This currently doesn't have a direct DB equivalent function to "get all accounts for all users"
        // But for backward compatibility with server.js health check, we might want to return something.
        // For now, return a placeholder or implement getAllAccounts in database.js if needed.
        // Since we changed to SQLite, let's just return a summary.
        return {
            summary: "Multi-user mode active (SQLite)",
            total: "N/A",
            available: "N/A",
            rateLimited: "N/A",
            invalid: "N/A"
        };
    }

    /**
     * Get OAuth token for an account
     */
    async getTokenForAccount(account) {
        const key = this.#getCacheKey(account);

        // Check cache
        const cached = this.#tokenCache.get(key);
        if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
            return cached.token;
        }

        let token;

        if (account.source === 'oauth' && account.refresh_token) {
            try {
                const tokens = await refreshAccessToken(account.refresh_token);
                token = tokens.accessToken;

                // Update access token in DB (optional, but good for persistence)
                // Also clear invalid status if it was invalid
                const updates = { access_token: token };
                if (account.is_invalid) {
                    updates.is_invalid = 0;
                    updates.invalid_reason = null;
                }
                updateAccount(account.id, updates);

                console.log(`[AccountManager] Refreshed OAuth token for: ${account.email}`);
            } catch (error) {
                console.error(`[AccountManager] Failed to refresh token for ${account.email}:`, error.message);
                this.markInvalid(account, error.message);
                throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
            }
        } else if (account.source === 'manual' && account.access_token) {
             // For manual accounts, we stored apiKey in access_token column or similar?
             // Checking database.js schema: users have api_key, upstream_accounts have access_token.
             // If source is manual, access_token likely holds the key.
             token = account.access_token;
        } else {
             // Database source or others - assuming access_token field holds the key
             token = account.access_token;
        }

        if (!token) {
            throw new Error(`No token found for account ${account.email}`);
        }

        // Cache
        this.#tokenCache.set(key, {
            token,
            extractedAt: Date.now()
        });

        return token;
    }

    /**
     * Get project ID for an account
     */
    async getProjectForAccount(account, token) {
        const key = this.#getCacheKey(account);

        // Check cache
        const cached = this.#projectCache.get(key);
        if (cached) return cached;

        // Check DB value
        if (account.project_id) {
            this.#projectCache.set(key, account.project_id);
            return account.project_id;
        }

        // Discover
        const project = await this.#discoverProject(token);

        // Update DB
        updateAccount(account.id, { project_id: project });
        this.#projectCache.set(key, project);

        return project;
    }

    async #discoverProject(token) {
        for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
            try {
                const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        ...ANTIGRAVITY_HEADERS
                    },
                    body: JSON.stringify({
                        metadata: {
                            ideType: 'IDE_UNSPECIFIED',
                            platform: 'PLATFORM_UNSPECIFIED',
                            pluginType: 'GEMINI'
                        }
                    })
                });

                if (!response.ok) continue;

                const data = await response.json();
                if (typeof data.cloudaicompanionProject === 'string') {
                    return data.cloudaicompanionProject;
                }
                if (data.cloudaicompanionProject?.id) {
                    return data.cloudaicompanionProject.id;
                }
            } catch (error) {
                console.log(`[AccountManager] Project discovery failed at ${endpoint}:`, error.message);
            }
        }
        return DEFAULT_PROJECT_ID;
    }

    clearTokenCache() {
        this.#tokenCache.clear();
    }

    clearProjectCache() {
        this.#projectCache.clear();
    }

    // Methods for admin/debug (returning all accounts is risky if many users)
    getAllAccounts() {
        // Not implemented for multi-user safety
        return [];
    }
}

export default AccountManager;
