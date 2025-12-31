/**
 * Authentication Middleware
 * Validates API keys and injects user context into the request.
 */

import { getUserByApiKey } from '../db/proxy-db.js';

export const authenticateUser = (req, res, next) => {
    // Skip auth for health checks and non-protected endpoints
    if (req.path === '/health' || req.path === '/' || req.method === 'OPTIONS') {
        return next();
    }

    // Try multiple header standards
    const apiKey =
        req.headers['x-api-key'] ||
        req.headers['anthropic-api-key'] ||
        req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey) {
        return res.status(401).json({
            error: {
                type: 'authentication_error',
                message: 'Missing API Key. Please provide x-api-key header.'
            }
        });
    }

    try {
        const user = getUserByApiKey(apiKey);

        if (!user) {
            // Log failed attempt (security)
            console.warn(`[Auth] Failed login attempt with invalid key: ${apiKey.substring(0, 8)}...`);
            return res.status(401).json({
                error: {
                    type: 'authentication_error',
                    message: 'Invalid API Key'
                }
            });
        }

        // Attach user context to request
        req.user = user;
        next();

    } catch (error) {
        console.error('[Auth] Database error during authentication:', error);
        return res.status(500).json({
            error: {
                type: 'server_error',
                message: 'Internal authentication error'
            }
        });
    }
};
