/**
 * Admin Authentication Routes
 * Handles user registration, login, and session management
 */

import { Router } from "express";
import crypto from "crypto";
import {
  createUser,
  getUserByName,
  getUserById,
  updateUser,
  listUsers,
} from "../services/database.js";

const router = Router();

// JWT-like token generation (simple implementation)
const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// In-memory token store (for simplicity - in production use Redis)
const tokenStore = new Map();

// Password hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const [salt, hash] = storedHash.split(":");
  const verifyHash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return hash === verifyHash;
}

// Generate API key
function generateApiKey() {
  return "sk-proxy-" + crypto.randomBytes(24).toString("hex");
}

// Generate auth token
function generateToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  tokenStore.set(token, {
    userId,
    expiresAt: Date.now() + TOKEN_EXPIRY,
  });
  return token;
}

// Verify auth token
function verifyToken(token) {
  const data = tokenStore.get(token);
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return data.userId;
}

// Auth middleware for admin routes
export function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.substring(7);
  const userId = verifyToken(token);

  if (!userId) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const user = getUserById(userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  req.user = user;
  next();
}

// Admin-only middleware
export function adminOnlyMiddleware(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// Register new user
router.post("/register", (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Check if username exists
    const existingUser = getUserByName(username);
    if (existingUser) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Check if this is the first user (make them admin)
    const users = listUsers();
    const isFirstUser = users.length === 0;

    // Create user
    const apiKey = generateApiKey();
    const passwordHash = hashPassword(password);
    const result = createUser(username, apiKey, passwordHash, isFirstUser);

    res.json({
      success: true,
      message: "Registration successful",
      user: {
        id: result.lastInsertRowid,
        username,
        is_admin: isFirstUser,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
router.post("/login", (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const user = getUserByName(username);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = generateToken(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        api_key: user.api_key,
        is_admin: !!user.is_admin,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Get current user
router.get("/me", adminAuthMiddleware, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    api_key: req.user.api_key,
    is_admin: !!req.user.is_admin,
    created_at: req.user.created_at,
  });
});

// Change password
router.post("/change-password", adminAuthMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Current and new password required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "New password must be at least 6 characters" });
    }

    if (!verifyPassword(currentPassword, req.user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newPasswordHash = hashPassword(newPassword);
    updateUser(req.user.id, { password_hash: newPasswordHash });

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Logout (invalidate token)
router.post("/logout", adminAuthMiddleware, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    tokenStore.delete(token);
  }
  res.json({ success: true });
});

export default router;
