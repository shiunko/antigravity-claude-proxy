/**
 * Base Input Adapter
 * Abstract base class for all input protocol adapters.
 */
export class BaseInput {
    constructor(orchestrator) {
        if (this.constructor === BaseInput) {
            throw new Error('BaseInput is an abstract class and cannot be instantiated');
        }
        this.orchestrator = orchestrator;
    }

    /**
     * Register routes with the Express app
     * @param {import('express').Application} app - Express application instance
     */
    register(app) {
        throw new Error('Method "register" must be implemented');
    }
}
