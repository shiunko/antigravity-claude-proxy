/**
 * Cloud Code Output Adapter
 * Adapts CoreRequest to Antigravity Cloud Code API calls.
 */

import crypto from 'crypto';
import { BaseOutput } from './base-output.js';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    MIN_SIGNATURE_LENGTH,
    getModelFamily,
    isThinkingModel
} from '../../constants.js';
import {
    convertAnthropicToGoogle,
    convertGoogleToAnthropic
} from '../../utils/converters/index.js';
import { cacheSignature } from '../../utils/converters/signature-cache.js';
import { formatDuration, sleep } from '../../utils/helpers.js';
import { isRateLimitError, isAuthError } from '../../utils/errors.js';
import { CoreResponse, StreamEvents } from '../../core/message.js';

export class CloudCodeOutput extends BaseOutput {
    constructor(accountManager) {
        super();
        this.accountManager = accountManager;
    }

    /**
     * Send a request to Cloud Code
     * @param {import('../../core/message.js').CoreRequest} coreRequest
     * @param {Object} context - Execution context (e.g. userId)
     */
    async send(coreRequest, context = {}) {
        const userId = context.userId;
        if (!userId) {
            throw new Error('UserId is required for CloudCodeOutput');
        }

        // Map CoreRequest to Anthropic format expected by converters
        const anthropicRequest = {
            model: coreRequest.model,
            messages: coreRequest.messages,
            system: coreRequest.system,
            tools: coreRequest.tools,
            // Map config fields
            max_tokens: coreRequest.config.maxTokens,
            temperature: coreRequest.config.temperature,
            top_p: coreRequest.config.topP,
            stop_sequences: coreRequest.config.stopSequences,
            // Map extensions
            thinking: coreRequest.extensions?.thinking,
            tool_choice: coreRequest.config.toolChoice // Add tool_choice if present in config
        };

        if (coreRequest.config.stream) {
            return this.sendMessageStream(anthropicRequest, userId);
        } else {
            return this.sendMessage(anthropicRequest, userId);
        }
    }

    /**
     * Send a non-streaming request
     */
    async sendMessage(anthropicRequest, userId) {
        const model = anthropicRequest.model;
        const isThinking = isThinkingModel(model);

        // Retry loop with account failover
        const accounts = this.accountManager.getAccounts(userId);
        const maxAttempts = Math.max(MAX_RETRIES, accounts.length + 1);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const { account: stickyAccount, waitMs } = this.accountManager.pickStickyAccount(userId);
            let account = stickyAccount;

            // Handle waiting for sticky account
            if (!account && waitMs > 0) {
                console.log(`[CloudCode] Waiting ${formatDuration(waitMs)} for sticky account...`);
                await sleep(waitMs);
                account = this.accountManager.pickNext(userId);
            }

            // Handle all accounts rate-limited
            if (!account) {
                if (this.accountManager.isAllRateLimited(userId)) {
                    await this.handleAllRateLimited(userId);
                    account = this.accountManager.pickNext(userId);
                }

                if (!account) {
                    throw new Error('No accounts available for this user');
                }
            }

            try {
                const token = await this.accountManager.getTokenForAccount(account);
                const project = await this.accountManager.getProjectForAccount(account, token);
                const payload = this.buildCloudCodeRequest(anthropicRequest, project);

                console.log(`[CloudCode] Sending request for model: ${model}`);

                // Try each endpoint
                let lastError = null;
                for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                    try {
                        const url = isThinking
                            ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                            : `${endpoint}/v1internal:generateContent`;

                        const response = await fetch(url, {
                            method: 'POST',
                            headers: this.buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
                            body: JSON.stringify(payload)
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            console.log(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                            if (response.status === 401) {
                                console.log('[CloudCode] Auth error, refreshing token...');
                                this.accountManager.clearTokenCache();
                                this.accountManager.clearProjectCache();
                                continue;
                            }

                            if (response.status === 429) {
                                console.log(`[CloudCode] Rate limited at ${endpoint}, trying next endpoint...`);
                                const resetMs = this.parseResetTime(response, errorText);
                                if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                    lastError = { is429: true, response, errorText, resetMs };
                                }
                                continue;
                            }

                            if (response.status >= 400) {
                                lastError = new Error(`API error ${response.status}: ${errorText}`);
                                continue;
                            }
                        }

                        // For thinking models, parse SSE and accumulate all parts
                        if (isThinking) {
                            const anthropicResponse = await this.parseThinkingSSEResponse(response, anthropicRequest.model);
                            return new CoreResponse(anthropicResponse);
                        }

                        // Non-thinking models use regular JSON
                        const data = await response.json();
                        console.log('[CloudCode] Response received');
                        const anthropicResponse = convertGoogleToAnthropic(data, anthropicRequest.model);
                        return new CoreResponse(anthropicResponse);

                    } catch (endpointError) {
                        if (isRateLimitError(endpointError)) {
                            throw endpointError;
                        }
                        console.log(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                        lastError = endpointError;
                    }
                }

                if (lastError) {
                    if (lastError.is429) {
                        console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                        this.accountManager.markRateLimited(account, lastError.resetMs);
                        throw new Error(`Rate limited: ${lastError.errorText}`);
                    }
                    throw lastError;
                }

            } catch (error) {
                if (isRateLimitError(error)) {
                    console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                    continue;
                }
                if (isAuthError(error)) {
                    console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Max retries exceeded');
    }

    /**
     * Send a streaming request
     */
    async *sendMessageStream(anthropicRequest, userId) {
        const model = anthropicRequest.model;

        // Retry loop with account failover
        const accounts = this.accountManager.getAccounts(userId);
        const maxAttempts = Math.max(MAX_RETRIES, accounts.length + 1);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const { account: stickyAccount, waitMs } = this.accountManager.pickStickyAccount(userId);
            let account = stickyAccount;

            if (!account && waitMs > 0) {
                console.log(`[CloudCode] Waiting ${formatDuration(waitMs)} for sticky account...`);
                await sleep(waitMs);
                account = this.accountManager.pickNext(userId);
            }

            if (!account) {
                if (this.accountManager.isAllRateLimited(userId)) {
                    await this.handleAllRateLimited(userId);
                    account = this.accountManager.pickNext(userId);
                }

                if (!account) {
                    throw new Error('No accounts available for this user');
                }
            }

            try {
                const token = await this.accountManager.getTokenForAccount(account);
                const project = await this.accountManager.getProjectForAccount(account, token);
                const payload = this.buildCloudCodeRequest(anthropicRequest, project);

                console.log(`[CloudCode] Starting stream for model: ${model}`);

                let lastError = null;
                for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                    try {
                        const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

                        const response = await fetch(url, {
                            method: 'POST',
                            headers: this.buildHeaders(token, model, 'text/event-stream'),
                            body: JSON.stringify(payload)
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            console.log(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);

                            if (response.status === 401) {
                                this.accountManager.clearTokenCache();
                                this.accountManager.clearProjectCache();
                                continue;
                            }

                            if (response.status === 429) {
                                console.log(`[CloudCode] Stream rate limited at ${endpoint}, trying next endpoint...`);
                                const resetMs = this.parseResetTime(response, errorText);
                                if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                    lastError = { is429: true, response, errorText, resetMs };
                                }
                                continue;
                            }

                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            continue;
                        }

                        // Stream response
                        yield* this.streamSSEResponse(response, anthropicRequest.model);

                        console.log('[CloudCode] Stream completed');
                        return;

                    } catch (endpointError) {
                        if (isRateLimitError(endpointError)) {
                            throw endpointError;
                        }
                        console.log(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                        lastError = endpointError;
                    }
                }

                if (lastError) {
                    if (lastError.is429) {
                        console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                        this.accountManager.markRateLimited(account, lastError.resetMs);
                        throw new Error(`Rate limited: ${lastError.errorText}`);
                    }
                    throw lastError;
                }

            } catch (error) {
                if (isRateLimitError(error)) {
                    console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                    continue;
                }
                if (isAuthError(error)) {
                    console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Max retries exceeded');
    }

    // --- Helper Methods ---

    async handleAllRateLimited(userId) {
        const userAccounts = this.accountManager.getAccounts(userId);
        let minWait = Infinity;
        const now = Date.now();

        for (const acc of userAccounts) {
            if (acc.rate_limit_reset_time) {
                const wait = acc.rate_limit_reset_time - now;
                if (wait > 0 && wait < minWait) minWait = wait;
            }
        }

        const allWaitMs = minWait === Infinity ? MAX_WAIT_BEFORE_ERROR_MS + 1000 : minWait;
        const resetTime = new Date(Date.now() + allWaitMs).toISOString();

        if (allWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
            throw new Error(
                `RESOURCE_EXHAUSTED: Rate limited. Quota will reset after ${formatDuration(allWaitMs)}. Next available: ${resetTime}`
            );
        }

        console.log(`[CloudCode] All accounts rate-limited for user ${userId}. Waiting ${formatDuration(allWaitMs)}...`);
        await sleep(allWaitMs);
    }

    buildCloudCodeRequest(anthropicRequest, projectId) {
        const model = anthropicRequest.model;
        const googleRequest = convertAnthropicToGoogle(anthropicRequest);

        googleRequest.sessionId = this.deriveSessionId(anthropicRequest);

        return {
            project: projectId,
            model: model,
            request: googleRequest,
            userAgent: 'antigravity',
            requestId: 'agent-' + crypto.randomUUID()
        };
    }

    buildHeaders(token, model, accept = 'application/json') {
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...ANTIGRAVITY_HEADERS
        };

        const modelFamily = getModelFamily(model);
        if (modelFamily === 'claude' && isThinkingModel(model)) {
            headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
        }

        if (accept !== 'application/json') {
            headers['Accept'] = accept;
        }

        return headers;
    }

    deriveSessionId(anthropicRequest) {
        const messages = anthropicRequest.messages || [];
        for (const msg of messages) {
            if (msg.role === 'user') {
                let content = '';
                if (typeof msg.content === 'string') {
                    content = msg.content;
                } else if (Array.isArray(msg.content)) {
                    content = msg.content
                        .filter(block => block.type === 'text' && block.text)
                        .map(block => block.text)
                        .join('\n');
                }

                if (content) {
                    const hash = crypto.createHash('sha256').update(content).digest('hex');
                    return hash.substring(0, 32);
                }
            }
        }
        return crypto.randomUUID();
    }

    parseResetTime(responseOrError, errorText = '') {
        let resetMs = null;
        if (responseOrError && typeof responseOrError.headers?.get === 'function') {
            const headers = responseOrError.headers;
            const retryAfter = headers.get('retry-after');
            if (retryAfter) {
                const seconds = parseInt(retryAfter, 10);
                if (!isNaN(seconds)) {
                    resetMs = seconds * 1000;
                } else {
                    const date = new Date(retryAfter);
                    if (!isNaN(date.getTime())) {
                        resetMs = date.getTime() - Date.now();
                    }
                }
            }
        }

        // Additional parsing logic for error bodies could be added here similar to original file
        // For brevity relying mostly on header or standard patterns
        return resetMs;
    }

    async parseThinkingSSEResponse(response, originalModel) {
        let accumulatedThinkingText = '';
        let accumulatedThinkingSignature = '';
        let accumulatedText = '';
        const finalParts = [];
        let usageMetadata = {};
        let finishReason = 'STOP';

        const flushThinking = () => {
            if (accumulatedThinkingText) {
                finalParts.push({
                    thought: true,
                    text: accumulatedThinkingText,
                    thoughtSignature: accumulatedThinkingSignature
                });
                accumulatedThinkingText = '';
                accumulatedThinkingSignature = '';
            }
        };

        const flushText = () => {
            if (accumulatedText) {
                finalParts.push({ text: accumulatedText });
                accumulatedText = '';
            }
        };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const jsonText = line.slice(5).trim();
                if (!jsonText) continue;

                try {
                    const data = JSON.parse(jsonText);
                    const innerResponse = data.response || data;

                    if (innerResponse.usageMetadata) {
                        usageMetadata = innerResponse.usageMetadata;
                    }

                    const candidates = innerResponse.candidates || [];
                    const firstCandidate = candidates[0] || {};
                    if (firstCandidate.finishReason) {
                        finishReason = firstCandidate.finishReason;
                    }

                    const parts = firstCandidate.content?.parts || [];
                    for (const part of parts) {
                        if (part.thought === true) {
                            flushText();
                            accumulatedThinkingText += (part.text || '');
                            if (part.thoughtSignature) {
                                accumulatedThinkingSignature = part.thoughtSignature;
                            }
                        } else if (part.functionCall) {
                            flushThinking();
                            flushText();
                            finalParts.push(part);
                        } else if (part.text !== undefined) {
                            if (!part.text) continue;
                            flushThinking();
                            accumulatedText += part.text;
                        }
                    }
                } catch (e) {
                    console.log('[CloudCode] SSE parse warning:', e.message);
                }
            }
        }

        flushThinking();
        flushText();

        const accumulatedResponse = {
            candidates: [{ content: { parts: finalParts }, finishReason }],
            usageMetadata
        };

        return convertGoogleToAnthropic(accumulatedResponse, originalModel);
    }

    async *streamSSEResponse(response, originalModel) {
        const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
        let hasEmittedStart = false;
        let blockIndex = 0;
        let currentBlockType = null;
        let currentThinkingSignature = '';
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let stopReason = 'end_turn';

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const jsonText = line.slice(5).trim();
                if (!jsonText) continue;

                try {
                    const data = JSON.parse(jsonText);
                    const innerResponse = data.response || data;

                    const usage = innerResponse.usageMetadata;
                    if (usage) {
                        inputTokens = usage.promptTokenCount || inputTokens;
                        outputTokens = usage.candidatesTokenCount || outputTokens;
                        cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens;
                    }

                    const candidates = innerResponse.candidates || [];
                    const firstCandidate = candidates[0] || {};
                    const content = firstCandidate.content || {};
                    const parts = content.parts || [];

                    if (!hasEmittedStart && parts.length > 0) {
                        hasEmittedStart = true;
                        yield {
                            type: StreamEvents.MESSAGE_START,
                            message: {
                                id: messageId,
                                type: 'message',
                                role: 'assistant',
                                content: [],
                                model: originalModel,
                                stop_reason: null,
                                stop_sequence: null,
                                usage: {
                                    input_tokens: inputTokens - cacheReadTokens,
                                    output_tokens: 0,
                                    cache_read_input_tokens: cacheReadTokens,
                                    cache_creation_input_tokens: 0
                                }
                            }
                        };
                    }

                    for (const part of parts) {
                        if (part.thought === true) {
                            const text = part.text || '';
                            const signature = part.thoughtSignature || '';

                            if (currentBlockType !== 'thinking') {
                                if (currentBlockType !== null) {
                                    yield { type: StreamEvents.CONTENT_BLOCK_STOP, index: blockIndex };
                                    blockIndex++;
                                }
                                currentBlockType = 'thinking';
                                currentThinkingSignature = '';
                                yield {
                                    type: StreamEvents.CONTENT_BLOCK_START,
                                    index: blockIndex,
                                    content_block: { type: 'thinking', thinking: '' }
                                };
                            }

                            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                                currentThinkingSignature = signature;
                            }

                            yield {
                                type: StreamEvents.CONTENT_BLOCK_DELTA,
                                index: blockIndex,
                                delta: { type: 'thinking_delta', thinking: text }
                            };

                        } else if (part.text !== undefined) {
                            if (!part.text || part.text.trim().length === 0) continue;

                            if (currentBlockType !== 'text') {
                                if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                    yield {
                                        type: StreamEvents.CONTENT_BLOCK_DELTA,
                                        index: blockIndex,
                                        delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                    };
                                    currentThinkingSignature = '';
                                }
                                if (currentBlockType !== null) {
                                    yield { type: StreamEvents.CONTENT_BLOCK_STOP, index: blockIndex };
                                    blockIndex++;
                                }
                                currentBlockType = 'text';
                                yield {
                                    type: StreamEvents.CONTENT_BLOCK_START,
                                    index: blockIndex,
                                    content_block: { type: 'text', text: '' }
                                };
                            }

                            yield {
                                type: StreamEvents.CONTENT_BLOCK_DELTA,
                                index: blockIndex,
                                delta: { type: 'text_delta', text: part.text }
                            };

                        } else if (part.functionCall) {
                            const functionCallSignature = part.thoughtSignature || '';

                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: StreamEvents.CONTENT_BLOCK_DELTA,
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: StreamEvents.CONTENT_BLOCK_STOP, index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'tool_use';
                            stopReason = 'tool_use';

                            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                            const toolUseBlock = {
                                type: 'tool_use',
                                id: toolId,
                                name: part.functionCall.name,
                                input: {}
                            };

                            if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                                toolUseBlock.thoughtSignature = functionCallSignature;
                                cacheSignature(toolId, functionCallSignature);
                            }

                            yield {
                                type: StreamEvents.CONTENT_BLOCK_START,
                                index: blockIndex,
                                content_block: toolUseBlock
                            };

                            yield {
                                type: StreamEvents.CONTENT_BLOCK_DELTA,
                                index: blockIndex,
                                delta: {
                                    type: 'input_json_delta',
                                    partial_json: JSON.stringify(part.functionCall.args || {})
                                }
                            };
                        }
                    }

                    if (firstCandidate.finishReason) {
                        if (firstCandidate.finishReason === 'MAX_TOKENS') {
                            stopReason = 'max_tokens';
                        } else if (firstCandidate.finishReason === 'STOP') {
                            stopReason = 'end_turn';
                        }
                    }

                } catch (parseError) {
                    console.log('[CloudCode] SSE parse error:', parseError.message);
                }
            }
        }

        if (!hasEmittedStart) {
             yield {
                type: StreamEvents.MESSAGE_START,
                message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: originalModel,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            };
            yield {
                type: StreamEvents.CONTENT_BLOCK_START,
                index: 0,
                content_block: { type: 'text', text: '' }
            };
            yield {
                type: StreamEvents.CONTENT_BLOCK_DELTA,
                index: 0,
                delta: { type: 'text_delta', text: '[No response received from API]' }
            };
            yield { type: StreamEvents.CONTENT_BLOCK_STOP, index: 0 };
        } else {
            if (currentBlockType !== null) {
                if (currentBlockType === 'thinking' && currentThinkingSignature) {
                    yield {
                        type: StreamEvents.CONTENT_BLOCK_DELTA,
                        index: blockIndex,
                        delta: { type: 'signature_delta', signature: currentThinkingSignature }
                    };
                }
                yield { type: StreamEvents.CONTENT_BLOCK_STOP, index: blockIndex };
            }
        }

        yield {
            type: StreamEvents.MESSAGE_DELTA,
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
                output_tokens: outputTokens,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: 0
            }
        };

        yield { type: StreamEvents.MESSAGE_STOP };
    }

    /**
     * List available models
     * @param {string} userId
     */
    async listModels(userId) {
        const account = this.accountManager.pickNext(userId);
        if (!account) {
            throw new Error('No accounts available for this user. Please add accounts or wait for rate limits to reset.');
        }
        const token = await this.accountManager.getTokenForAccount(account);

        const data = await this.fetchAvailableModels(token);
        if (!data || !data.models) {
            return { object: 'list', data: [] };
        }

        const modelList = Object.entries(data.models).map(([modelId, modelData]) => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: modelData.displayName || modelId
        }));

        return {
            object: 'list',
            data: modelList
        };
    }

    /**
     * Get model quotas for a specific token
     * @param {string} token
     */
    async getModelQuotas(token) {
        const data = await this.fetchAvailableModels(token);
        if (!data || !data.models) return {};

        const quotas = {};
        for (const [modelId, modelData] of Object.entries(data.models)) {
            if (modelData.quotaInfo) {
                quotas[modelId] = {
                    remainingFraction: modelData.quotaInfo.remainingFraction ?? null,
                    resetTime: modelData.quotaInfo.resetTime ?? null
                };
            }
        }

        return quotas;
    }

    /**
     * Fetch available models from Cloud Code API
     * @param {string} token
     */
    async fetchAvailableModels(token) {
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...ANTIGRAVITY_HEADERS
        };

        for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
            try {
                const url = `${endpoint}/v1internal:fetchAvailableModels`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({})
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.log(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                    continue;
                }

                return await response.json();
            } catch (error) {
                console.log(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
            }
        }

        throw new Error('Failed to fetch available models from all endpoints');
    }
}
