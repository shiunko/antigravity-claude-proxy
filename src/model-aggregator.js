/**
 * Model Aggregator
 * Resolves virtual model aliases to actual model candidates with failover support.
 */

import { getModelGroup } from './db/proxy-db.js';

export class ModelAggregator {
    /**
     * Resolve a model name to a list of candidate models.
     * If the model name is a virtual alias, returns the configured models.
     * Otherwise, returns the original model name as a single-item array.
     *
     * @param {number} userId - The user ID
     * @param {string} modelName - The requested model name (may be a virtual alias)
     * @returns {string[]} - Array of actual model names to try
     */
    resolve(userId, modelName) {
        // Query database for virtual model alias
        const group = getModelGroup(userId, modelName);

        // If not a virtual model, return the original model
        if (!group || !group.items || group.items.length === 0) {
            return [modelName];
        }

        // Copy items for manipulation
        let candidates = [...group.items];

        if (group.strategy === 'random') {
            // Fisher-Yates shuffle algorithm
            for (let i = candidates.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }
        } else {
            // 'priority' strategy: sort by order_index ascending
            candidates.sort((a, b) => a.order_index - b.order_index);
        }

        // Extract model_name strings
        return candidates.map(item => item.model_name);
    }

    /**
     * Check if an error is a rate limit error that should trigger failover.
     *
     * @param {Error} error - The error to check
     * @returns {boolean} - True if this is a rate limit error
     */
    isRateLimitError(error) {
        if (!error) return false;

        // Check status code
        if (error.status === 429) return true;

        // Check error message for common rate limit indicators
        const message = error.message || '';
        return (
            message.includes('RESOURCE_EXHAUSTED') ||
            message.includes('QUOTA_EXHAUSTED') ||
            message.includes('rate_limit_exceeded') ||
            message.includes('429')
        );
    }
}
