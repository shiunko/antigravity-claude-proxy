import { createUser, getUserByName, getUserByApiKey } from '../src/db/proxy-db.js';

console.log('Checking for test user configuration...');

try {
    // Check if user exists by API key 'test'
    const existingKey = getUserByApiKey('test');
    if (existingKey) {
        console.log(`Test user already exists with API key 'test' (username: ${existingKey.username})`);
        process.exit(0);
    }

    // Check if username 'test-user' exists
    const existingName = getUserByName('test-user');
    if (existingName) {
        console.log('User "test-user" exists but has different key. Creating new "test-runner" user.');
        createUser('test-runner', 'test');
    } else {
        console.log('Creating "test-user" with API key "test"...');
        createUser('test-user', 'test');
    }

    console.log('Test user seeded successfully.');
} catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
        console.log('Test user likely already exists (race condition or constraint), skipping.');
    } else {
        console.error('Failed to seed test user:', error.message);
        process.exit(1);
    }
}
