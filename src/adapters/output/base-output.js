/**
 * Base Output Adapter
 * Interface for all output adapters (LLM providers).
 */
export class BaseOutput {
    constructor() {
        if (this.constructor === BaseOutput) {
            throw new Error('BaseOutput is an abstract class and cannot be instantiated');
        }
    }

    /**
     * Send a request to the LLM provider
     * @param {import('../../core/message.js').CoreRequest} request - The standardized request
     * @returns {Promise<import('../../core/message.js').CoreResponse | AsyncGenerator>} Response or Stream
     */
    async send(request) {
        throw new Error('Method "send" must be implemented');
    }

    /**
     * Check if this adapter supports the requested model
     * @param {string} model - Model identifier
     * @returns {boolean} True if supported
     */
    supports(model) {
        return true; // Default to accepting all, specific adapters can filter
    }
}
