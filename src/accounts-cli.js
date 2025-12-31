#!/usr/bin/env node

/**
 * Account Management CLI
 *
 * Interactive CLI for adding and managing Google accounts
 * for the Antigravity Claude Proxy.
 *
 * Usage:
 *   node src/accounts-cli.js          # Interactive mode
 *   node src/accounts-cli.js add      # Add new account(s)
 *   node src/accounts-cli.js list     # List all accounts
 *   node src/accounts-cli.js remove   # Remove accounts
 *   node src/accounts-cli.js verify   # Verify account tokens
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { exec } from 'child_process';
import { DEFAULT_PORT, MAX_ACCOUNTS } from './constants.js';
import {
    getAuthorizationUrl,
    startCallbackServer,
    completeOAuthFlow,
    refreshAccessToken,
    getUserEmail
} from './services/auth.js';
import {
    listUsers,
    createUser,
    getAccountsForUser,
    addAccount as addAccountToDb,
    deleteAccount as deleteAccountFromDb,
    updateAccount
} from './services/database.js';

// --- UI Helpers ---

function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

async function askQuestion(rl, query) {
    return await rl.question(query);
}

function openBrowser(url) {
    const platform = process.platform;
    let command;

    if (platform === 'darwin') {
        command = `open "${url}"`;
    } else if (platform === 'win32') {
        command = `start "" "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
    }

    exec(command, (error) => {
        if (error) {
            console.log('\n⚠ Could not open browser automatically.');
            console.log('Please open this URL manually:', url);
        }
    });
}

// --- User Selection ---

async function selectUser(rl, argsUser) {
    // 1. If user provided via flag (not implemented in args parsing yet, but planned)
    if (argsUser) {
        const users = listUsers();
        const match = users.find(u => u.username === argsUser);
        if (match) return match;
        console.error(`User '${argsUser}' not found.`);
        process.exit(1);
    }

    // 2. Interactive selection
    const users = listUsers();

    if (users.length === 0) {
        console.log('\nNo users found in the database.');
        const answer = await askQuestion(rl, 'Would you like to create a new user now? [Y/n]: ');
        if (answer.toLowerCase() === 'n') {
            process.exit(0);
        }

        const username = await askQuestion(rl, 'Enter new username: ');
        if (!username) process.exit(1);

        // Generate a random key for them (conceptually similar to user-cli)
        const { randomBytes } = await import('crypto');
        const apiKey = 'sk-proxy-' + randomBytes(24).toString('hex');

        try {
            createUser(username, apiKey);
            console.log(`User '${username}' created.`);
            console.log(`API Key: ${apiKey} (Save this!)`);
            return listUsers().find(u => u.username === username);
        } catch (e) {
            console.error('Failed to create user:', e.message);
            process.exit(1);
        }
    }

    if (users.length === 1) {
        console.log(`Using user: ${users[0].username}`);
        return users[0];
    }

    console.log('\nSelect User:');
    users.forEach((u, i) => {
        console.log(`${i + 1}. ${u.username}`);
    });

    while (true) {
        const answer = await askQuestion(rl, '\nEnter number (or 0 to exit): ');
        const idx = parseInt(answer, 10);
        if (idx === 0) process.exit(0);

        if (idx > 0 && idx <= users.length) {
            return users[idx - 1];
        }
        console.log('Invalid selection.');
    }
}

// --- Actions ---

async function addAccount(rl, user) {
    console.log(`\n=== Add Google Account for ${user.username} ===\n`);

    const accounts = getAccountsForUser(user.id);
    if (accounts.length >= MAX_ACCOUNTS) {
        console.log(`Max accounts (${MAX_ACCOUNTS}) reached for this user.`);
        return;
    }

    // OAuth Flow
    const { url, verifier, state } = getAuthorizationUrl();

    console.log('Opening browser for Google sign-in...');
    console.log(`URL: ${url}\n`);
    openBrowser(url);

    console.log('Waiting for authentication (timeout: 2 minutes)...');

    try {
        const code = await startCallbackServer(state);
        console.log('Received code, exchanging for tokens...');

        const result = await completeOAuthFlow(code, verifier);

        // Check for duplicates
        const existing = accounts.find(a => a.email === result.email);
        if (existing) {
            console.log(`\n⚠ Account ${result.email} already exists. Updating tokens...`);
            updateAccount(existing.id, {
                refresh_token: result.refreshToken,
                project_id: result.projectId,
                is_invalid: 0,
                invalid_reason: null
            });
            console.log('Updated successfully.');
            return;
        }

        // Insert
        addAccountToDb({
            user_id: user.id,
            email: result.email,
            source: 'oauth',
            refresh_token: result.refreshToken,
            project_id: result.projectId,
            added_at: Date.now()
        });

        console.log(`\n✓ Successfully added: ${result.email}`);
        if (result.projectId) console.log(`  Project: ${result.projectId}`);

    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
    }
}

async function listAccountsAction(user) {
    const accounts = getAccountsForUser(user.id);
    console.log(`\nAccounts for ${user.username} (${accounts.length}):`);

    if (accounts.length === 0) {
        console.log('  (None)');
        return;
    }

    accounts.forEach((acc, i) => {
        const status = acc.is_invalid
            ? 'INVALID'
            : (acc.is_rate_limited ? 'RATE LIMITED' : 'OK');

        console.log(`  ${i+1}. ${acc.email} [${status}]`);
        if (acc.project_id) console.log(`     Project: ${acc.project_id}`);
    });
}

async function removeAccount(rl, user) {
    const accounts = getAccountsForUser(user.id);
    if (accounts.length === 0) {
        console.log('No accounts to remove.');
        return;
    }

    await listAccountsAction(user);

    const answer = await askQuestion(rl, '\nEnter number to remove (or 0 to cancel): ');
    const idx = parseInt(answer, 10);

    if (idx > 0 && idx <= accounts.length) {
        const acc = accounts[idx - 1];
        const confirm = await askQuestion(rl, `Remove ${acc.email}? [y/N]: `);
        if (confirm.toLowerCase() === 'y') {
            deleteAccountFromDb(user.id, acc.email);
            console.log('Removed.');
        }
    }
}

async function verifyAccountsAction(user) {
    const accounts = getAccountsForUser(user.id);
    if (accounts.length === 0) {
        console.log('No accounts to verify.');
        return;
    }

    console.log(`\nVerifying accounts for ${user.username}...\n`);

    for (const acc of accounts) {
        process.stdout.write(`  ${acc.email} ... `);

        if (acc.source === 'oauth' && acc.refresh_token) {
            try {
                const tokens = await refreshAccessToken(acc.refresh_token);
                // Optionally update DB with new access token
                updateAccount(acc.id, {
                    access_token: tokens.accessToken,
                    is_invalid: 0,
                    invalid_reason: null
                });
                console.log('OK');
            } catch (e) {
                console.log(`FAIL (${e.message})`);
                updateAccount(acc.id, {
                    is_invalid: 1,
                    invalid_reason: e.message
                });
            }
        } else {
            console.log('SKIP (Not OAuth)');
        }
    }
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'menu';

    // Parse --user flag if present
    const userFlagIdx = args.indexOf('--user');
    let userArg = null;
    if (userFlagIdx !== -1 && args[userFlagIdx + 1]) {
        userArg = args[userFlagIdx + 1];
    }

    const rl = createRL();

    try {
        const user = await selectUser(rl, userArg);

        if (command === 'menu') {
            while (true) {
                console.log(`\n=== Account Manager (${user.username}) ===`);
                console.log('1. List accounts');
                console.log('2. Add account');
                console.log('3. Remove account');
                console.log('4. Verify accounts');
                console.log('5. Switch user');
                console.log('0. Exit');

                const answer = await askQuestion(rl, '\nSelect option: ');

                if (answer === '1') await listAccountsAction(user);
                else if (answer === '2') await addAccount(rl, user);
                else if (answer === '3') await removeAccount(rl, user);
                else if (answer === '4') await verifyAccountsAction(user);
                else if (answer === '5') {
                    // Switch user - primitive way: restart main loop logic or just recurse?
                    // Simpler: Just exit loop and let recursion handle it or restart process?
                    // Let's just exit and tell them to restart for now to keep it simple, or re-select.
                    console.log('Please restart tool to switch user.');
                    process.exit(0);
                }
                else if (answer === '0') process.exit(0);
            }
        } else {
            // One-off commands
            switch (command) {
                case 'add': await addAccount(rl, user); break;
                case 'list': await listAccountsAction(user); break;
                case 'remove': await removeAccount(rl, user); break;
                case 'verify': await verifyAccountsAction(user); break;
                default:
                    console.log('Unknown command. Available: add, list, remove, verify');
            }
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        rl.close();
    }
}

main();
