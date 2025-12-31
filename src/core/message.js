import crypto from 'crypto';

/**
 * Core Request Object
 * Standardized request format for internal processing.
 * Based on Anthropic Messages API but extensible.
 */
export class CoreRequest {
    constructor(data = {}) {
        this.requestId = data.requestId || crypto.randomUUID();
        this.model = data.model; // Original model name (e.g. "claude-3-opus-20240229", "gpt-4o")

        // Normalize messages to array of { role, content: [...] }
        this.messages = (data.messages || []).map(msg => ({
            role: msg.role,
            content: Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
        }));

        // System prompt (normalized to string for simplicity in core, but can be array)
        this.system = data.system;

        // Tool definitions
        this.tools = data.tools || [];

        // Generation configuration
        this.config = {
            temperature: data.config?.temperature, // Let backend defaults apply if undefined
            maxTokens: data.config?.maxTokens,
            stream: !!data.config?.stream,
            topP: data.config?.topP,
            stopSequences: data.config?.stopSequences,
            ...data.config
        };

        // Extension fields for custom behavior (thinking, user context, etc.)
        this.extensions = data.extensions || {};
    }
}

/**
 * Core Response Object
 * Standardized response format for internal processing.
 */
export class CoreResponse {
    constructor(data = {}) {
        this.id = data.id || `msg_${crypto.randomUUID()}`;
        this.model = data.model;
        this.role = data.role || 'assistant';
        this.content = data.content || []; // Array of content blocks
        this.stopReason = data.stopReason || 'end_turn';
        this.stopSequence = data.stopSequence || null;
        this.usage = {
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0
        };
    }
}

/**
 * Stream Event Types
 * Standardized event types for streaming responses
 */
export const StreamEvents = {
    MESSAGE_START: 'message_start',
    CONTENT_BLOCK_START: 'content_block_start',
    CONTENT_BLOCK_DELTA: 'content_block_delta',
    CONTENT_BLOCK_STOP: 'content_block_stop',
    MESSAGE_DELTA: 'message_delta',
    MESSAGE_STOP: 'message_stop',
    PING: 'ping',
    ERROR: 'error'
};
