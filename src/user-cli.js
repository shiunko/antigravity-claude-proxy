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
import {
    createUser,
    listUsers,
    deleteUser,
    getUserByName,
    createModelGroup,
    addModelToGroup,
    getModelGroup,
    listModelGroups,
    deleteModelGroup,
    removeModelFromGroup
} from './services/database.js';

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

// --- Model Group Commands ---

async function handleGroupCreate() {
    const username = args[0];
    const alias = args[1];
    const strategy = args[2] || 'priority';

    if (!username || !alias) {
        console.error('Usage: node src/user-cli.js group:create <username> <alias> [strategy]');
        console.error('  strategy: priority (default), random');
        process.exit(1);
    }

    if (!['priority', 'random'].includes(strategy)) {
        console.error(`Invalid strategy '${strategy}'. Use 'priority' or 'random'.`);
        process.exit(1);
    }

    try {
        const user = getUserByName(username);
        if (!user) {
            console.error(`User '${username}' not found.`);
            process.exit(1);
        }

        const existing = getModelGroup(user.id, alias);
        if (existing) {
            console.error(`Model group '${alias}' already exists for user '${username}'.`);
            process.exit(1);
        }

        const result = createModelGroup(user.id, alias, strategy);
        console.log(`Model group '${alias}' created for user '${username}' (ID: ${result.lastInsertRowid}).`);
        console.log(`Strategy: ${strategy}`);
        console.log(`\nNow add models using: npm run users group:add ${username} ${alias} <model-name> [order]`);
    } catch (error) {
        console.error('Failed to create model group:', error.message);
        process.exit(1);
    }
}

async function handleGroupAdd() {
    const username = args[0];
    const alias = args[1];
    const modelName = args[2];
    const orderIndex = parseInt(args[3], 10) || 0;

    if (!username || !alias || !modelName) {
        console.error('Usage: node src/user-cli.js group:add <username> <alias> <model-name> [order]');
        console.error('  order: priority order (lower = higher priority). Default: 0');
        process.exit(1);
    }

    try {
        const user = getUserByName(username);
        if (!user) {
            console.error(`User '${username}' not found.`);
            process.exit(1);
        }

        const group = getModelGroup(user.id, alias);
        if (!group) {
            console.error(`Model group '${alias}' not found for user '${username}'.`);
            console.error(`Create it first with: npm run users group:create ${username} ${alias}`);
            process.exit(1);
        }

        addModelToGroup(group.id, modelName, orderIndex);
        console.log(`Added model '${modelName}' to group '${alias}' with order ${orderIndex}.`);
    } catch (error) {
        console.error('Failed to add model to group:', error.message);
        process.exit(1);
    }
}

async function handleGroupList() {
    const username = args[0];

    if (!username) {
        console.error('Usage: node src/user-cli.js group:list <username>');
        process.exit(1);
    }

    try {
        const user = getUserByName(username);
        if (!user) {
            console.error(`User '${username}' not found.`);
            process.exit(1);
        }

        const groups = listModelGroups(user.id);
        if (groups.length === 0) {
            console.log(`No model groups found for user '${username}'.`);
            return;
        }

        console.log(`Model groups for user '${username}':\n`);
        for (const group of groups) {
            console.log(`[${group.alias}] (strategy: ${group.strategy})`);
            if (group.items.length === 0) {
                console.log('  (no models configured)');
            } else {
                for (const item of group.items) {
                    console.log(`  ${item.order_index}: ${item.model_name}`);
                }
            }
            console.log('');
        }
    } catch (error) {
        console.error('Failed to list model groups:', error.message);
        process.exit(1);
    }
}

async function handleGroupDelete() {
    const username = args[0];
    const alias = args[1];

    if (!username || !alias) {
        console.error('Usage: node src/user-cli.js group:delete <username> <alias>');
        process.exit(1);
    }

    try {
        const user = getUserByName(username);
        if (!user) {
            console.error(`User '${username}' not found.`);
            process.exit(1);
        }

        const result = deleteModelGroup(user.id, alias);
        if (result.changes > 0) {
            console.log(`Model group '${alias}' deleted for user '${username}'.`);
        } else {
            console.error(`Model group '${alias}' not found for user '${username}'.`);
        }
    } catch (error) {
        console.error('Failed to delete model group:', error.message);
        process.exit(1);
    }
}

async function handleGroupRemove() {
    const username = args[0];
    const alias = args[1];
    const modelName = args[2];

    if (!username || !alias || !modelName) {
        console.error('Usage: node src/user-cli.js group:remove <username> <alias> <model-name>');
        process.exit(1);
    }

    try {
        const user = getUserByName(username);
        if (!user) {
            console.error(`User '${username}' not found.`);
            process.exit(1);
        }

        const group = getModelGroup(user.id, alias);
        if (!group) {
            console.error(`Model group '${alias}' not found for user '${username}'.`);
            process.exit(1);
        }

        const result = removeModelFromGroup(group.id, modelName);
        if (result.changes > 0) {
            console.log(`Removed model '${modelName}' from group '${alias}'.`);
        } else {
            console.error(`Model '${modelName}' not found in group '${alias}'.`);
        }
    } catch (error) {
        console.error('Failed to remove model from group:', error.message);
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
        case 'group:create':
            await handleGroupCreate();
            break;
        case 'group:add':
            await handleGroupAdd();
            break;
        case 'group:list':
            await handleGroupList();
            break;
        case 'group:delete':
            await handleGroupDelete();
            break;
        case 'group:remove':
            await handleGroupRemove();
            break;
        default:
            console.log('User Management Commands:');
            console.log('  create <username>           Create a new user and generate API key');
            console.log('  list                        List all users');
            console.log('  delete <username>           Delete a user');
            console.log('');
            console.log('Model Group Commands:');
            console.log('  group:create <user> <alias> [strategy]  Create a model group');
            console.log('  group:add <user> <alias> <model> [ord]  Add model to a group');
            console.log('  group:list <user>                       List user\'s model groups');
            console.log('  group:delete <user> <alias>             Delete a model group');
            console.log('  group:remove <user> <alias> <model>     Remove model from group');
            break;
    }
}

main();
