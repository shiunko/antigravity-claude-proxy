/**
 * Format Converter Module
 * Converts between Anthropic Messages API format and Google Generative AI format
 */

// Re-export all from each module
export * from './google-format.js';
export * from './anthropic-format.js';
export * from './openai-format.js';
export * from './content-converter.js';
export * from './schema-sanitizer.js';
export * from './thinking-utils.js';

// Default export for backward compatibility
import { convertAnthropicToGoogle } from './google-format.js';
import { convertGoogleToAnthropic } from './anthropic-format.js';

export default {
    convertAnthropicToGoogle,
    convertGoogleToAnthropic
};
