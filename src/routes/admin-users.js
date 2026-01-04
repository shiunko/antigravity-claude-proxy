/**
 * Admin Users Routes
 * Handles user management (admin only)
 */

import { Router } from "express";
import crypto from "crypto";
import {
  createUser,
  listUsers,
  getUserById,
  deleteUserById,
  updateUser,
} from "../services/database.js";
import { adminAuthMiddleware, adminOnlyMiddleware } from "./admin-auth.js";

const router = Router();

// Apply auth middleware to all routes
router.use(adminAuthMiddleware);
router.use(adminOnlyMiddleware);

// Generate API key
function generateApiKey() {
  return "sk-proxy-" + crypto.randomBytes(24).toString("hex");
}

// Password hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

// List all users
router.get("/", (req, res) => {
  try {
    const users = listUsers();
    res.json(users);
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ error: "Failed to list users" });
  }
});

// Create new user
router.post("/", (req, res) => {
  try {
    const { username, password, is_admin } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const apiKey = generateApiKey();
    const passwordHash = hashPassword(password);
    const result = createUser(username, apiKey, passwordHash, !!is_admin);

    res.json({
      success: true,
      user: {
        id: result.lastInsertRowid,
        username,
        api_key: apiKey,
        is_admin: !!is_admin,
      },
    });
  } catch (error) {
    console.error("Create user error:", error);
    if (error.message?.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Delete user
router.delete("/:id", (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent self-deletion
    if (userId === req.user.id) {
      return res.status(400).json({ error: "Cannot delete yourself" });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    deleteUserById(userId);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Regenerate API key for user
router.post("/:id/regenerate-key", (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const newApiKey = generateApiKey();
    updateUser(userId, { api_key: newApiKey });

    res.json({
      success: true,
      api_key: newApiKey,
    });
  } catch (error) {
    console.error("Regenerate key error:", error);
    res.status(500).json({ error: "Failed to regenerate API key" });
  }
});

export default router;
