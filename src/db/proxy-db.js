/**
 * Proxy Internal Database
 * Manages users and their associated upstream accounts.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

// Database path config
const CONFIG_DIR = join(homedir(), '.config', 'antigravity-proxy');
const DB_PATH = join(CONFIG_DIR, 'proxy.db');

// Ensure config dir exists
try {
    mkdirSync(CONFIG_DIR, { recursive: true });
} catch (e) {
    // Ignore if exists
}

let dbInstance = null;

export function getDb() {
    if (!dbInstance) {
        dbInstance = new Database(DB_PATH);
        initDb(dbInstance);
    }
    return dbInstance;
}

function initDb(db) {
    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Users table
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            api_key TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Upstream Accounts table
    db.exec(`
        CREATE TABLE IF NOT EXISTS upstream_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            source TEXT NOT NULL, -- 'oauth', 'manual', 'database'
            refresh_token TEXT,
            access_token TEXT,
            project_id TEXT,
            is_rate_limited INTEGER DEFAULT 0, -- boolean 0/1
            rate_limit_reset_time INTEGER,
            is_invalid INTEGER DEFAULT 0, -- boolean 0/1
            invalid_reason TEXT,
            last_used INTEGER,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, email)
        )
    `);
}

// --- User Operations ---

export function createUser(username, apiKey) {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO users (username, api_key) VALUES (?, ?)');
    return stmt.run(username, apiKey);
}

export function getUserByApiKey(apiKey) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM users WHERE api_key = ?');
    return stmt.get(apiKey);
}

export function getUserByName(username) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    return stmt.get(username);
}

export function listUsers() {
    const db = getDb();
    return db.prepare('SELECT id, username, created_at FROM users').all();
}

export function deleteUser(username) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM users WHERE username = ?');
    return stmt.run(username);
}

// --- Account Operations ---

export function addAccount(accountData) {
    const db = getDb();
    const keys = [
        'user_id', 'email', 'source', 'refresh_token', 'access_token',
        'project_id', 'is_rate_limited', 'rate_limit_reset_time',
        'is_invalid', 'invalid_reason', 'last_used'
    ];

    // Filter undefined values
    const data = {};
    keys.forEach(k => {
        if (accountData[k] !== undefined) data[k] = accountData[k];
    });

    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const stmt = db.prepare(`INSERT INTO upstream_accounts (${columns}) VALUES (${placeholders})`);
    return stmt.run(...values);
}

export function getAccountsForUser(userId) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM upstream_accounts WHERE user_id = ?');
    const accounts = stmt.all(userId);

    // Convert SQLite 0/1 to booleans
    return accounts.map(acc => ({
        ...acc,
        is_rate_limited: !!acc.is_rate_limited,
        is_invalid: !!acc.is_invalid
    }));
}

export function updateAccount(id, updates) {
    const db = getDb();
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), id];

    const stmt = db.prepare(`UPDATE upstream_accounts SET ${setClause} WHERE id = ?`);
    return stmt.run(...values);
}

export function deleteAccount(userId, email) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM upstream_accounts WHERE user_id = ? AND email = ?');
    return stmt.run(userId, email);
}

// Reset rate limits that have expired
export function clearExpiredRateLimits() {
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
        UPDATE upstream_accounts
        SET is_rate_limited = 0, rate_limit_reset_time = NULL
        WHERE is_rate_limited = 1 AND rate_limit_reset_time <= ?
    `);
    return stmt.run(now);
}
