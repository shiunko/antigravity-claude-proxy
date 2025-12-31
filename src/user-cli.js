#!/usr/bin/env node

/**
 * User Management CLI
 * Usage:
 *   node src/user-cli.js create <username>
 *   node src/user-cli.js list
 *   node src/user-cli.js delete <username>
 *   node src/user-cli.js reset-key <username>
 */

import { randomBytes } from 'crypto';
import { createUser, listUsers, deleteUser, getUserByName, updateUser } from './db/proxy-db.js';

const command = process.argv[2];
const args = process.argv.slice(3);

function generateApiKey() {
    return 'sk-proxy-' + randomBytes(24).toString('hex');
}

async function handleCreate() {
    const username = args[0];
    if (!username) {
        console.error('Usage: node src/user-cli.js create <username>');
        process.exit(1);
    }

    try {
        const existing = getUserByName(username);
        if (existing) {
            console.error(`Error: User '${username}' already exists.`);
            process.exit(1);
        }

        const apiKey = generateApiKey();
        createUser(username, apiKey);

        console.log(`User created successfully!`);
        console.log(`Username: ${username}`);
        console.log(`API Key:  ${apiKey}`);
        console.log(`\nShare this API Key with the user. They should use it in their client configuration.`);
    } catch (error) {
        console.error('Failed to create user:', error.message);
        process.exit(1);
    }
}

async function handleList() {
    try {
        const users = listUsers();
        if (users.length === 0) {
            console.log('No users found.');
            return;
        }

        console.log('ID  | Username             | Created At');
        console.log('----|----------------------|----------------------');
        users.forEach(u => {
            console.log(`${u.id.toString().padEnd(3)} | ${u.username.padEnd(20)} | ${u.created_at}`);
        });
    } catch (error) {
        console.error('Failed to list users:', error.message);
        process.exit(1);
    }
}

async function handleDelete() {
    const username = args[0];
    if (!username) {
        console.error('Usage: node src/user-cli.js delete <username>');
        process.exit(1);
    }

    try {
        const result = deleteUser(username);
        if (result.changes > 0) {
            console.log(`User '${username}' deleted.`);
        } else {
            console.error(`User '${username}' not found.`);
        }
    } catch (error) {
        console.error('Failed to delete user:', error.message);
        process.exit(1);
    }
}

async function main() {
    switch (command) {
        case 'create':
            await handleCreate();
            break;
        case 'list':
            await handleList();
            break;
        case 'delete':
            await handleDelete();
            break;
        default:
            console.log('Available commands:');
            console.log('  create <username>   Create a new user and generate API key');
            console.log('  list                List all users');
            console.log('  delete <username>   Delete a user');
            break;
    }
}

main();
