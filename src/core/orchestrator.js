/**
 * Orchestrator
 * Central component that coordinates requests between Input and Output adapters.
 * Handles model resolution, routing, and error handling.
 */

import { ApiError } from "../utils/errors.js";

export class Orchestrator {
  constructor(modelAggregator) {
    this.modelAggregator = modelAggregator;
    this.adapters = new Map(); // Map<string, BaseOutput>
    this.defaultAdapter = null;
  }

  /**
   * Register an output adapter
   * @param {string} name - Adapter name (e.g. 'cloudcode', 'openai')
   * @param {import('../adapters/output/base-output.js').BaseOutput} adapter - Adapter instance
   * @param {boolean} isDefault - Whether this is the default adapter
   */
  registerAdapter(name, adapter, isDefault = false) {
    this.adapters.set(name, adapter);
    if (isDefault) {
      this.defaultAdapter = adapter;
    }
  }

  /**
   * Handle a Core Request
   * @param {import('./message.js').CoreRequest} request - The core request object
   * @param {Object} context - Execution context (userId, etc.)
   * @returns {Promise<import('./message.js').CoreResponse | AsyncGenerator>} Response or Stream
   */
  async handle(request, context) {
    const userId = context.userId;
    const requestedModel = request.model;

    // 1. Resolve Model Aliases
    // The aggregator returns an array of candidates (e.g. ['gemini-2.0-flash', 'gemini-1.5-pro'])
    // We'll try them in order until one works.
    const modelCandidates = this.modelAggregator.resolve(
      userId,
      requestedModel,
    );

    console.log(
      `[Orchestrator] User ${userId} requested '${requestedModel}', resolved to:`,
      modelCandidates,
    );

    let lastError = null;

    // 2. Try each model candidate
    for (const model of modelCandidates) {
      try {
        // Update request with actual model name
        // We create a shallow copy to avoid mutating the original request for retries
        const currentRequest = {
          ...request,
          model: model,
        };

        // 3. Select Adapter
        // Currently we default to the registered default (CloudCode)
        // In future, we could route based on model prefix (e.g. 'gpt-' -> OpenAI adapter)
        const adapter = this.selectAdapter(model);

        if (!adapter) {
          throw new Error(`No adapter found for model: ${model}`);
        }

        // 4. Execute Request
        return await adapter.send(currentRequest, context);
      } catch (error) {
        console.log(`[Orchestrator] Error with model ${model}:`, error.message);

        // Check if we should failover
        const isRateLimit = this.modelAggregator.isRateLimitError(error);
        const isAuthError =
          error.message.includes("Auth") || error.status === 401; // Simple check

        // If it's a critical error that failover might fix (Rate Limit, overload), try next candidate
        if (isRateLimit || error.status >= 500) {
          lastError = error;
          continue;
        }

        // For other errors (invalid request, bad params), fail immediately
        throw error;
      }
    }

    // 5. If all candidates failed
    throw lastError || new ApiError(500, "All model candidates failed");
  }

  /**
   * Select the appropriate adapter for a model
   * @param {string} model - Model name
   */
  selectAdapter(model) {
    // Simple routing logic for now:
    // If we had an OpenAI adapter, we could check:
    // if (model.startsWith('gpt-') || model.startsWith('o1-')) return this.adapters.get('openai');

    // Return default adapter (CloudCode)
    return this.defaultAdapter;
  }
}
