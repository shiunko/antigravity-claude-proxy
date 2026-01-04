/**
 * Admin Accounts Routes
 * Handles upstream Google account management
 */

import { Router } from "express";
import {
  addAccount,
  getAccountsForUser,
  getAccountById,
  deleteAccountById,
  updateAccount,
} from "../services/database.js";
import { adminAuthMiddleware } from "./admin-auth.js";
import {
  getAuthorizationUrl,
  startCallbackServer,
  completeOAuthFlow,
  refreshAccessToken,
} from "../services/auth.js";
import { AccountManager } from '../services/account-manager.js';
import { CloudCodeOutput } from '../adapters/output/cloudcode-output.js';

const router = Router();

// Initialize services for quota checking
const accountManager = new AccountManager();
const cloudCodeOutput = new CloudCodeOutput(accountManager);

// Store pending OAuth sessions
const pendingOAuthSessions = new Map();

// Apply auth middleware to all routes
router.use(adminAuthMiddleware);

// List all accounts for current user
router.get("/", (req, res) => {
  try {
    const accounts = getAccountsForUser(req.user.id);
    // Hide sensitive data
    const safeAccounts = accounts.map((acc) => ({
      id: acc.id,
      email: acc.email,
      source: acc.source,
      project_id: acc.project_id,
      is_rate_limited: acc.is_rate_limited,
      rate_limit_reset_time: acc.rate_limit_reset_time,
      is_invalid: acc.is_invalid,
      invalid_reason: acc.invalid_reason,
      last_used: acc.last_used,
      added_at: acc.added_at,
    }));
    res.json(safeAccounts);
  } catch (error) {
    console.error("List accounts error:", error);
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

// Get account limits (quota) for all accounts
router.get("/limits", async (req, res) => {
  try {
    const userId = req.user.id;
    const allAccounts = accountManager.getAccounts(userId);
    const format = req.query.format || 'json';

    if (allAccounts.length === 0) {
      return res.json({
        timestamp: new Date().toLocaleString(),
        user: req.user.email,
        totalAccounts: 0,
        models: [],
        accounts: []
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

    // JSON format (Admin UI expects JSON)
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
    console.error("Account limits error:", error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Start OAuth flow
router.post("/oauth/start", async (req, res) => {
  try {
    const { url, verifier, state } = getAuthorizationUrl();

    // Store session data for callback
    pendingOAuthSessions.set(state, {
      userId: req.user.id,
      verifier,
      createdAt: Date.now(),
      status: 'pending'
    });

    // Clean up old sessions (older than 10 minutes)
    const now = Date.now();
    for (const [key, session] of pendingOAuthSessions.entries()) {
      if (now - session.createdAt > 600000) {
        pendingOAuthSessions.delete(key);
      }
    }

    // Start callback server in background
    startCallbackServer(state, 300000)
      .then(async (code) => {
        const session = pendingOAuthSessions.get(state);
        if (!session) return;

        session.status = 'processing';

        try {
          const accountInfo = await completeOAuthFlow(code, session.verifier);

          addAccount({
            user_id: session.userId,
            email: accountInfo.email,
            source: "oauth",
            refresh_token: accountInfo.refreshToken,
            access_token: accountInfo.accessToken,
            project_id: accountInfo.projectId,
          });

          console.log(`[OAuth] Account added: ${accountInfo.email}`);
          session.status = 'completed';
        } catch (error) {
          console.error("[OAuth] Failed to complete flow:", error);
          session.status = 'error';
          session.error = error.message;
        }
        // Don't delete immediately so frontend can check status
      })
      .catch((error) => {
        console.error("[OAuth] Callback error:", error);
        const session = pendingOAuthSessions.get(state);
        if (session) {
          session.status = 'error';
          session.error = error.message;
        }
      });

    res.json({ authUrl: url, state });
  } catch (error) {
    console.error("OAuth start error:", error);
    res.status(500).json({ error: "Failed to start OAuth flow" });
  }
});

// Check OAuth status
router.get("/oauth/status/:state", (req, res) => {
  const { state } = req.params;
  const session = pendingOAuthSessions.get(state);

  if (!session) {
    return res.status(404).json({ status: "not_found", error: "Session not found or expired" });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  res.json({
    status: session.status,
    error: session.error
  });
});

// Add account manually
router.post("/manual", (req, res) => {
  try {
    const { email, refresh_token, project_id } = req.body;

    if (!email || !refresh_token) {
      return res
        .status(400)
        .json({ error: "Email and refresh_token are required" });
    }

    const result = addAccount({
      user_id: req.user.id,
      email,
      source: "manual",
      refresh_token,
      project_id: project_id || null,
    });

    res.json({
      success: true,
      id: result.lastInsertRowid,
    });
  } catch (error) {
    console.error("Add account error:", error);
    if (error.message?.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Account already exists" });
    }
    res.status(500).json({ error: "Failed to add account" });
  }
});

// Verify account
router.post("/:id/verify", async (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    const account = getAccountById(accountId);

    if (!account || account.user_id !== req.user.id) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Try to refresh token
    const result = await refreshAccessToken(account.refresh_token);

    // Update account status
    updateAccount(accountId, {
      access_token: result.accessToken,
      is_invalid: 0,
      invalid_reason: null,
    });

    res.json({ success: true, message: "Account verified successfully" });
  } catch (error) {
    console.error("Verify account error:", error);

    // Mark as invalid
    const accountId = parseInt(req.params.id);
    updateAccount(accountId, {
      is_invalid: 1,
      invalid_reason: error.message || "Token refresh failed",
    });

    res.status(400).json({
      error: "Verification failed",
      reason: error.message,
    });
  }
});

// Delete account
router.delete("/:id", (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    const account = getAccountById(accountId);

    if (!account || account.user_id !== req.user.id) {
      return res.status(404).json({ error: "Account not found" });
    }

    deleteAccountById(accountId);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

export default router;
