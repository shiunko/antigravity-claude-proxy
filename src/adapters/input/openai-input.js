/**
 * OpenAI Input Adapter
 * Handles requests compatible with OpenAI Chat Completions API.
 */

import { BaseInput } from './base-input.js';
import { CoreRequest } from '../../core/message.js';
import { ApiError } from '../../utils/errors.js';
import {
    convertOpenAIToCore,
    convertCoreToOpenAI,
    convertCoreStreamToOpenAI
} from '../../utils/converters/index.js';

export class OpenAIInput extends BaseInput {
    register(app) {
        app.post('/v1/chat/completions', this.handleRequest.bind(this));
    }

    async handleRequest(req, res) {
        try {
            const {
                model,
                messages,
                stream
            } = req.body;

            // Basic Validation
            if (!messages || !Array.isArray(messages)) {
                throw new ApiError(400, 'messages is required and must be an array', 'invalid_request_error');
            }

            if (!model) {
                throw new ApiError(400, 'model is required', 'invalid_request_error');
            }

            // Convert to Core Request
            const coreRequestData = convertOpenAIToCore(req.body);
            const coreRequest = new CoreRequest(coreRequestData);

            // Context
            const context = {
                userId: req.user.id,
                userEmail: req.user.email
            };

            // Execute via Orchestrator
            const result = await this.orchestrator.handle(coreRequest, context);

            // Handle Response
            if (stream) {
                this.sendStreamResponse(res, result, model);
            } else {
                this.sendJSONResponse(res, result);
            }

        } catch (error) {
            this.sendErrorResponse(res, error);
        }
    }

    sendJSONResponse(res, result) {
        const response = convertCoreToOpenAI(result);
        res.json(response);
    }

    async sendStreamResponse(res, generator, model) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (res.flushHeaders) res.flushHeaders();

        try {
            for await (const event of generator) {
                const chunk = convertCoreStreamToOpenAI(event, model);
                if (chunk) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    if (res.flush) res.flush();
                }
            }
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (error) {
            console.error('[OpenAIInput] Stream error:', error);

            // If headers sent, we can't send a proper error JSON, but we can try to send a data error or just end
            // OpenAI clients often look for data: [DONE], but if we error we might want to just close connection
            if (!res.headersSent) {
                this.sendErrorResponse(res, error);
            } else {
                // OpenAI doesn't have a standard "error event" in the stream like Anthropic does
                // Usually just closing the connection is the safest bet, or sending a specific error chunk if client supports it
                // We'll just end it here.
                res.end();
            }
        }
    }

    sendErrorResponse(res, error) {
        const { statusCode, errorType, errorMessage } = this.formatError(error);
        res.status(statusCode).json({
            error: {
                message: errorMessage,
                type: errorType,
                param: null,
                code: null
            }
        });
    }

    formatError(error) {
        let statusCode = error.status || 500;
        let errorType = 'server_error';
        let errorMessage = error.message;

        // Map common errors
        if (errorMessage.includes('401') || errorMessage.includes('Auth')) {
            statusCode = 401;
            errorType = 'invalid_request_error';
        } else if (errorMessage.includes('Rate limit') || errorMessage.includes('429')) {
            statusCode = 429;
            errorType = 'rate_limit_error'; // OpenAI uses specific types sometimes but this is safe
        } else if (statusCode === 400) {
            errorType = 'invalid_request_error';
        }

        return { statusCode, errorType, errorMessage };
    }
}
