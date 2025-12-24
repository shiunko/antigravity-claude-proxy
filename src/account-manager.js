/**
 * Account Manager
 * Manages multiple Antigravity accounts with round-robin selection,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import {
    ACCOUNT_CONFIG_PATH,
    ANTIGRAVITY_DB_PATH,
    DEFAULT_COOLDOWN_MS,
    TOKEN_REFRESH_INTERVAL_MS,
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID
} from './constants.js';
import { refreshAccessToken } from './oauth.js';
import { formatDuration } from './utils/helpers.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH) {
        this.#configPath = configPath;
    }

    /**
     * Initialize the account manager by loading config
     */
    async initialize() {
        if (this.#initialized) return;

        try {
            // Check if config file exists using async access
            await access(this.#configPath, fsConstants.F_OK);
            const configData = await readFile(this.#configPath, 'utf-8');
            const config = JSON.parse(configData);

            this.#accounts = (config.accounts || []).map(acc => ({
                ...acc,
                isRateLimited: acc.isRateLimited || false,
                rateLimitResetTime: acc.rateLimitResetTime || null,
                lastUsed: acc.lastUsed || null
            }));

            this.#settings = config.settings || {};
            this.#currentIndex = config.activeIndex || 0;

            // Clamp currentIndex to valid range
            if (this.#currentIndex >= this.#accounts.length) {
                this.#currentIndex = 0;
            }

            console.log(`[AccountManager] Loaded ${this.#accounts.length} account(s) from config`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // No config file - use single account from Antigravity database
                console.log('[AccountManager] No config file found. Using Antigravity database (single account mode)');
            } else {
                console.error('[AccountManager] Failed to load config:', error.message);
            }
            // Fall back to default account
            await this.#loadDefaultAccount();
        }

        // Clear any expired rate limits
        this.clearExpiredLimits();

        this.#initialized = true;
    }

    /**
     * Load the default account from Antigravity's database
     */
    async #loadDefaultAccount() {
        try {
            const authData = this.#extractTokenFromDB();
            if (authData?.apiKey) {
                this.#accounts = [{
                    email: authData.email || 'default@antigravity',
                    source: 'database',
                    isRateLimited: false,
                    rateLimitResetTime: null,
                    lastUsed: null
                }];
                // Pre-cache the token
                this.#tokenCache.set(this.#accounts[0].email, {
                    token: authData.apiKey,
                    extractedAt: Date.now()
                });
                console.log(`[AccountManager] Loaded default account: ${this.#accounts[0].email}`);
            }
        } catch (error) {
            console.error('[AccountManager] Failed to load default account:', error.message);
            // Create empty account list - will fail on first request
            this.#accounts = [];
        }
    }

    /**
     * Extract token from Antigravity's SQLite database
     */
    #extractTokenFromDB(dbPath = ANTIGRAVITY_DB_PATH) {
        const result = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';"`,
            { encoding: 'utf-8', timeout: 5000 }
        );

        if (!result || !result.trim()) {
            throw new Error('No auth status found in database');
        }

        return JSON.parse(result.trim());
    }

    /**
     * Get the number of accounts
     * @returns {number} Number of configured accounts
     */
    getAccountCount() {
        return this.#accounts.length;
    }

    /**
     * Check if all accounts are rate-limited
     * @returns {boolean} True if all accounts are rate-limited
     */
    isAllRateLimited() {
        if (this.#accounts.length === 0) return true;
        return this.#accounts.every(acc => acc.isRateLimited);
    }

    /**
     * Get list of available (non-rate-limited, non-invalid) accounts
     * @returns {Array<Object>} Array of available account objects
     */
    getAvailableAccounts() {
        return this.#accounts.filter(acc => !acc.isRateLimited && !acc.isInvalid);
    }

    /**
     * Get list of invalid accounts
     * @returns {Array<Object>} Array of invalid account objects
     */
    getInvalidAccounts() {
        return this.#accounts.filter(acc => acc.isInvalid);
    }

    /**
     * Clear expired rate limits
     * @returns {number} Number of rate limits cleared
     */
    clearExpiredLimits() {
        const now = Date.now();
        let cleared = 0;

        for (const account of this.#accounts) {
            if (account.isRateLimited && account.rateLimitResetTime && account.rateLimitResetTime <= now) {
                account.isRateLimited = false;
                account.rateLimitResetTime = null;
                cleared++;
                console.log(`[AccountManager] Rate limit expired for: ${account.email}`);
            }
        }

        if (cleared > 0) {
            this.saveToDisk();
        }

        return cleared;
    }

    /**
     * Clear all rate limits to force a fresh check
     * (Optimistic retry strategy)
     * @returns {void}
     */
    resetAllRateLimits() {
        for (const account of this.#accounts) {
            account.isRateLimited = false;
            // distinct from "clearing" expired limits, we blindly reset here
            // we keep the time? User said "clear isRateLimited value, and rateLimitResetTime"
            // So we clear both.
            account.rateLimitResetTime = null;
        }
        console.log('[AccountManager] Reset all rate limits for optimistic retry');
    }

    /**
     * Pick the next available account (round-robin)
     * @returns {Object|null} The next available account or null if none available
     */
    pickNext() {
        this.clearExpiredLimits();

        const available = this.getAvailableAccounts();
        if (available.length === 0) {
            return null;
        }

        // Find next available account starting from current index
        for (let i = 0; i < this.#accounts.length; i++) {
            const idx = (this.#currentIndex + i) % this.#accounts.length;
            const account = this.#accounts[idx];

            if (!account.isRateLimited && !account.isInvalid) {
                this.#currentIndex = (idx + 1) % this.#accounts.length;
                account.lastUsed = Date.now();

                const position = this.#accounts.indexOf(account) + 1;
                const total = this.#accounts.length;
                console.log(`[AccountManager] Using account: ${account.email} (${position}/${total})`);

                return account;
            }
        }

        return null;
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     */
    markRateLimited(email, resetMs = null) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return;

        account.isRateLimited = true;
        const cooldownMs = resetMs || this.#settings.cooldownDurationMs || DEFAULT_COOLDOWN_MS;
        account.rateLimitResetTime = Date.now() + cooldownMs;

        console.log(
            `[AccountManager] Rate limited: ${email}. Available in ${formatDuration(cooldownMs)}`
        );

        this.saveToDisk();
    }

    /**
     * Mark an account as invalid (credentials need re-authentication)
     * @param {string} email - Email of the account to mark
     * @param {string} reason - Reason for marking as invalid
     */
    markInvalid(email, reason = 'Unknown error') {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return;

        account.isInvalid = true;
        account.invalidReason = reason;
        account.invalidAt = Date.now();

        console.log(
            `[AccountManager] ⚠ Account INVALID: ${email}`
        );
        console.log(
            `[AccountManager]   Reason: ${reason}`
        );
        console.log(
            `[AccountManager]   Run 'npm run accounts' to re-authenticate this account`
        );

        this.saveToDisk();
    }

    /**
     * Get the minimum wait time until any account becomes available
     * @returns {number} Wait time in milliseconds
     */
    getMinWaitTimeMs() {
        if (!this.isAllRateLimited()) return 0;

        const now = Date.now();
        let minWait = Infinity;
        let soonestAccount = null;

        for (const account of this.#accounts) {
            if (account.rateLimitResetTime) {
                const wait = account.rateLimitResetTime - now;
                if (wait > 0 && wait < minWait) {
                    minWait = wait;
                    soonestAccount = account;
                }
            }
        }

        if (soonestAccount) {
            console.log(`[AccountManager] Shortest wait: ${formatDuration(minWait)} (account: ${soonestAccount.email})`);
        }

        return minWait === Infinity ? DEFAULT_COOLDOWN_MS : minWait;
    }

    /**
     * Get OAuth token for an account
     * @param {Object} account - Account object with email and credentials
     * @returns {Promise<string>} OAuth access token
     * @throws {Error} If token refresh fails
     */
    async getTokenForAccount(account) {
        // Check cache first
        const cached = this.#tokenCache.get(account.email);
        if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
            return cached.token;
        }

        // Get fresh token based on source
        let token;

        if (account.source === 'oauth' && account.refreshToken) {
            // OAuth account - use refresh token to get new access token
            try {
                const tokens = await refreshAccessToken(account.refreshToken);
                token = tokens.accessToken;
                // Clear invalid flag on success
                if (account.isInvalid) {
                    account.isInvalid = false;
                    account.invalidReason = null;
                    await this.saveToDisk();
                }
                console.log(`[AccountManager] Refreshed OAuth token for: ${account.email}`);
            } catch (error) {
                console.error(`[AccountManager] Failed to refresh token for ${account.email}:`, error.message);
                // Mark account as invalid (credentials need re-auth)
                this.markInvalid(account.email, error.message);
                throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
            }
        } else if (account.source === 'manual' && account.apiKey) {
            token = account.apiKey;
        } else {
            // Extract from database
            const dbPath = account.dbPath || ANTIGRAVITY_DB_PATH;
            const authData = this.#extractTokenFromDB(dbPath);
            token = authData.apiKey;
        }

        // Cache the token
        this.#tokenCache.set(account.email, {
            token,
            extractedAt: Date.now()
        });

        return token;
    }

    /**
     * Get project ID for an account
     * @param {Object} account - Account object
     * @param {string} token - OAuth access token
     * @returns {Promise<string>} Project ID
     */
    async getProjectForAccount(account, token) {
        // Check cache first
        const cached = this.#projectCache.get(account.email);
        if (cached) {
            return cached;
        }

        // OAuth or manual accounts may have projectId specified
        if (account.projectId) {
            this.#projectCache.set(account.email, account.projectId);
            return account.projectId;
        }

        // Discover project via loadCodeAssist API
        const project = await this.#discoverProject(token);
        this.#projectCache.set(account.email, project);
        return project;
    }

    /**
     * Discover project ID via Cloud Code API
     */
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

        console.log(`[AccountManager] Using default project: ${DEFAULT_PROJECT_ID}`);
        return DEFAULT_PROJECT_ID;
    }

    /**
     * Clear project cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearProjectCache(email = null) {
        if (email) {
            this.#projectCache.delete(email);
        } else {
            this.#projectCache.clear();
        }
    }

    /**
     * Clear token cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearTokenCache(email = null) {
        if (email) {
            this.#tokenCache.delete(email);
        } else {
            this.#tokenCache.clear();
        }
    }

    /**
     * Save current state to disk (async)
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        try {
            // Ensure directory exists
            const dir = dirname(this.#configPath);
            await mkdir(dir, { recursive: true });

            const config = {
                accounts: this.#accounts.map(acc => ({
                    email: acc.email,
                    source: acc.source,
                    dbPath: acc.dbPath || null,
                    refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                    apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                    projectId: acc.projectId || undefined,
                    addedAt: acc.addedAt || undefined,
                    isRateLimited: acc.isRateLimited,
                    rateLimitResetTime: acc.rateLimitResetTime,
                    isInvalid: acc.isInvalid || false,
                    invalidReason: acc.invalidReason || null,
                    lastUsed: acc.lastUsed
                })),
                settings: this.#settings,
                activeIndex: this.#currentIndex
            };

            await writeFile(this.#configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            console.error('[AccountManager] Failed to save config:', error.message);
        }
    }

    /**
     * Get status object for logging/API
     * @returns {{accounts: Array, settings: Object}} Status object with accounts and settings
     */
    getStatus() {
        const available = this.getAvailableAccounts();
        const rateLimited = this.#accounts.filter(a => a.isRateLimited);
        const invalid = this.getInvalidAccounts();

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                email: a.email,
                source: a.source,
                isRateLimited: a.isRateLimited,
                rateLimitResetTime: a.rateLimitResetTime,
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                lastUsed: a.lastUsed
            }))
        };
    }

    /**
     * Get settings
     * @returns {Object} Current settings object
     */
    getSettings() {
        return { ...this.#settings };
    }
}

export default AccountManager;
