/**
 * Anthropic Input Adapter
 * Handles requests compatible with Anthropic Messages API.
 */

import { BaseInput } from './base-input.js';
import { CoreRequest, StreamEvents } from '../../core/message.js';
import { ApiError } from '../../utils/errors.js';

export class AnthropicInput extends BaseInput {
    register(app) {
        app.post('/v1/messages', this.handleRequest.bind(this));

        // Count tokens endpoint (stub)
        app.post('/v1/messages/count_tokens', (req, res) => {
            res.status(501).json({
                type: 'error',
                error: {
                    type: 'not_implemented',
                    message: 'Token counting is not implemented.'
                }
            });
        });
    }

    async handleRequest(req, res) {
        try {
            const {
                model,
                messages,
                system,
                max_tokens,
                temperature,
                top_p,
                top_k,
                stop_sequences,
                stream,
                tools,
                tool_choice,
                thinking
            } = req.body;

            // Validation
            if (!messages || !Array.isArray(messages)) {
                throw new ApiError(400, 'messages is required and must be an array', 'invalid_request_error');
            }

            if (!model) {
                throw new ApiError(400, 'model is required', 'invalid_request_error');
            }

            // Create Core Request
            const coreRequest = new CoreRequest({
                model,
                messages,
                system,
                tools,
                config: {
                    maxTokens: max_tokens,
                    temperature,
                    topP: top_p,
                    stopSequences: stop_sequences,
                    stream,
                    toolChoice: tool_choice // Pass through to be mapped in Output adapter
                },
                extensions: {
                    thinking
                }
            });

            // Context
            const context = {
                userId: req.user.id,
                userEmail: req.user.email
            };

            // Execute via Orchestrator
            const result = await this.orchestrator.handle(coreRequest, context);

            // Handle Response
            if (stream) {
                this.sendStreamResponse(res, result);
            } else {
                this.sendJSONResponse(res, result);
            }

        } catch (error) {
            this.sendErrorResponse(res, error);
        }
    }

    sendJSONResponse(res, result) {
        // CoreResponse properties map 1:1 to Anthropic format
        // We just need to ensure we return the plain object
        const response = {
            id: result.id,
            type: 'message',
            role: result.role,
            content: result.content,
            model: result.model,
            stop_reason: result.stopReason,
            stop_sequence: result.stopSequence,
            usage: result.usage
        };
        res.json(response);
    }

    async sendStreamResponse(res, generator) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (res.flushHeaders) res.flushHeaders();

        try {
            for await (const event of generator) {
                // Events from Orchestrator/Output match Anthropic SSE format exactly
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                if (res.flush) res.flush();
            }
            res.end();
        } catch (error) {
            console.error('[AnthropicInput] Stream error:', error);

            // If headers sent, send error event
            if (!res.headersSent) {
                this.sendErrorResponse(res, error);
            } else {
                const { errorType, errorMessage } = this.formatError(error);
                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }
        }
    }

    sendErrorResponse(res, error) {
        const { statusCode, errorType, errorMessage } = this.formatError(error);
        res.status(statusCode).json({
            type: 'error',
            error: {
                type: errorType,
                message: errorMessage
            }
        });
    }

    formatError(error) {
        let statusCode = error.status || 500;
        let errorType = error.type || 'api_error';
        let errorMessage = error.message;

        // Map common errors
        if (errorMessage.includes('401') || errorMessage.includes('Auth')) {
            statusCode = 401;
            errorType = 'authentication_error';
        } else if (errorMessage.includes('Rate limit') || errorMessage.includes('429')) {
            statusCode = 429;
            errorType = 'rate_limit_error';
        }

        return { statusCode, errorType, errorMessage };
    }
}
