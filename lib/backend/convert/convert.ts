/**
 * Protocol conversion system (ported from aiclient-2-api)
 * Full ConverterFactory implementation
 */

import logger from '../utils/logger';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../utils/common';

// Import all converters
import { OpenAIConverter } from './strategies/OpenAIConverter';
import { ClaudeConverter } from './strategies/ClaudeConverter';
import { GeminiConverter } from './strategies/GeminiConverter';

/**
 * Converter Factory (ported from ConverterFactory.js)
 */
class ConverterFactoryClass {
    private converters = new Map<string, any>();
    private converterClasses = new Map<string, any>();

    constructor() {
        // Auto-register all converters (точь-в-точь как в register-converters.js)
        this.registerConverter(MODEL_PROTOCOL_PREFIX.OPENAI, OpenAIConverter);
        this.registerConverter(MODEL_PROTOCOL_PREFIX.CLAUDE, ClaudeConverter);
        this.registerConverter(MODEL_PROTOCOL_PREFIX.GEMINI, GeminiConverter);
        // TODO: Add more converters
    }

    registerConverter(protocolPrefix: string, ConverterClass: any) {
        this.converterClasses.set(protocolPrefix, ConverterClass);
    }

    getConverter(protocolPrefix: string) {
        logger.info(`[ConverterFactory] Getting converter for: ${protocolPrefix}`);
        
        // Check cache
        if (this.converters.has(protocolPrefix)) {
            logger.info(`[ConverterFactory] Found in cache: ${protocolPrefix}`);
            return this.converters.get(protocolPrefix);
        }

        // Create new instance
        const ConverterClass = this.converterClasses.get(protocolPrefix);
        
        if (!ConverterClass) {
            logger.warn(`[ConverterFactory] No converter registered for protocol: ${protocolPrefix}`);
            logger.info(`[ConverterFactory] Registered protocols: ${Array.from(this.converterClasses.keys()).join(', ')}`);
            return null;
        }

        logger.info(`[ConverterFactory] Creating new converter for: ${protocolPrefix}`);
        const converter = new ConverterClass();
        
        // Cache instance
        this.converters.set(protocolPrefix, converter);

        return converter;
    }

    clearCache() {
        this.converters.clear();
    }
}

// Singleton instance
const ConverterFactory = new ConverterFactoryClass();

/**
 * Convert data between different API formats (ported from convert.js::convertData)
 */
export function convertData(
    data: any,
    type: string,
    fromProvider: string,
    toProvider: string,
    model?: string,
    requestId?: string
): any {
    try {
        // Get protocol prefixes (точь-в-точь как в оригинале)
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);

        // Skip conversion for forward protocol (точь-в-точь как в оригинале)
        if (toProtocol === MODEL_PROTOCOL_PREFIX.FORWARD || fromProtocol === MODEL_PROTOCOL_PREFIX.FORWARD) {
            logger.info(`[Convert] Target protocol is forward, skipping conversion`);
            return data;
        }

        // Get converter from factory (точь-в-точь как в оригинале)
        const converter = ConverterFactory.getConverter(fromProtocol);

        if (!converter) {
            logger.warn(`[Convert] No converter found for ${fromProtocol}, returning original data`);
            return data;
        }

        // Call appropriate conversion method (точь-в-точь как в оригинале)
        switch (type) {
            case 'request':
                return converter.convertRequest(data, toProtocol);
                
            case 'response':
                return converter.convertResponse(data, toProtocol, model);
                
            case 'streamChunk':
                return converter.convertStreamChunk(data, toProtocol, model, requestId);
                
            case 'modelList':
                return converter.convertModelList(data, toProtocol);
                
            default:
                logger.warn(`[Convert] Unsupported conversion type: ${type}`);
                return data;
        }
    } catch (error: any) {
        logger.error(`[Convert] Conversion error: ${error.message}`);
        return data; // Return original data on error
    }
}

