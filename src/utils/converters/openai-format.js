/**
 * OpenAI Format Converter
 * Converts between OpenAI Chat Completions API format and Core/Anthropic format.
 */

import { StreamEvents } from '../../core/message.js';

/**
 * Convert OpenAI request body to Core Request
 * @param {Object} body - OpenAI request body
 * @returns {Object} Partial Core Request structure
 */
export function convertOpenAIToCore(body) {
    const {
        model,
        messages,
        max_tokens,
        temperature,
        top_p,
        stop,
        stream,
        tools,
        tool_choice
    } = body;

    // Extract system message if present
    let system = undefined;
    const coreMessages = [];

    if (Array.isArray(messages)) {
        for (const msg of messages) {
            if (msg.role === 'system') {
                // Concatenate multiple system messages if necessary
                system = system ? `${system}\n${msg.content}` : msg.content;
            } else {
                // OpenAI content can be string or array (for vision)
                // Anthropic supports string or array too, but structure might differ slightly for images
                // For now assuming text-only or compatible structure, or let downstream handle detailed content mapping
                coreMessages.push({
                    role: msg.role,
                    content: msg.content
                });
            }
        }
    }

    return {
        model,
        messages: coreMessages,
        system,
        // Tools format is different, but for now we pass through
        // If we need deep conversion of tools, we'd do it here
        tools,
        config: {
            maxTokens: max_tokens,
            temperature,
            topP: top_p,
            stopSequences: Array.isArray(stop) ? stop : (stop ? [stop] : undefined),
            stream,
            toolChoice: tool_choice
        }
    };
}

/**
 * Convert Core Response to OpenAI Response (Non-streaming)
 * @param {import('../../core/message.js').CoreResponse} result
 * @returns {Object} OpenAI response object
 */
export function convertCoreToOpenAI(result) {
    return {
        id: result.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [
            {
                index: 0,
                message: {
                    role: result.role,
                    content: result.contentText // Helper to get text only, or handle blocks
                },
                finish_reason: mapStopReason(result.stopReason)
            }
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0)
        }
    };
}

/**
 * Convert Core Stream Event to OpenAI Stream Chunk
 * @param {Object} event - Core stream event
 * @param {string} model - Model name
 * @returns {Object|null} OpenAI chunk object or null if should be skipped
 */
export function convertCoreStreamToOpenAI(event, model) {
    const base = {
        id: event.message?.id || 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model
    };

    switch (event.type) {
        case StreamEvents.MESSAGE_START:
            return {
                ...base,
                id: event.message.id,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: '' },
                    finish_reason: null
                }]
            };

        case StreamEvents.CONTENT_BLOCK_DELTA:
            if (event.delta.type === 'text_delta') {
                return {
                    ...base,
                    choices: [{
                        index: 0,
                        delta: { content: event.delta.text },
                        finish_reason: null
                    }]
                };
            }
            // Thinking/Signature deltas are ignored in OpenAI format usually,
            // or we could output them if we wanted to be non-standard.
            // For now, ignore.
            return null;

        case StreamEvents.MESSAGE_DELTA:
            return {
                ...base,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: mapStopReason(event.delta.stop_reason)
                }]
            };

        case StreamEvents.MESSAGE_STOP:
            return {
                ...base,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: null // Already sent in MESSAGE_DELTA usually, but safe to send empty
                }]
            };

        default:
            return null;
    }
}

function mapStopReason(reason) {
    switch (reason) {
        case 'end_turn': return 'stop';
        case 'max_tokens': return 'length';
        case 'tool_use': return 'tool_calls';
        default: return reason;
    }
}
