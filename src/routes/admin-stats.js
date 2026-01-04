/**
 * Admin Stats Routes
 * Provides statistics and monitoring data
 */

import { Router } from "express";
import { getAccountsForUser, listModelGroups } from "../services/database.js";
import { adminAuthMiddleware } from "./admin-auth.js";

const router = Router();

// Apply auth middleware to all routes
router.use(adminAuthMiddleware);

// Get dashboard stats
router.get("/", (req, res) => {
  try {
    const accounts = getAccountsForUser(req.user.id);
    const groups = listModelGroups(req.user.id);

    const stats = {
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter((a) => !a.is_invalid && !a.is_rate_limited)
        .length,
      rateLimitedAccounts: accounts.filter((a) => a.is_rate_limited).length,
      invalidAccounts: accounts.filter((a) => a.is_invalid).length,
      totalModelGroups: groups.length,
    };

    res.json(stats);
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Get account status details
router.get("/accounts", (req, res) => {
  try {
    const accounts = getAccountsForUser(req.user.id);

    const accountStats = accounts.map((acc) => ({
      email: acc.email,
      status: acc.is_invalid
        ? "invalid"
        : acc.is_rate_limited
          ? "rate_limited"
          : "active",
      lastUsed: acc.last_used,
      rateLimitResetTime: acc.rate_limit_reset_time,
      invalidReason: acc.invalid_reason,
    }));

    res.json(accountStats);
  } catch (error) {
    console.error("Get account stats error:", error);
    res.status(500).json({ error: "Failed to get account stats" });
  }
});

export default router;
