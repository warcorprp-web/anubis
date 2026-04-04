

import logger from '../utils/logger';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../utils/common';


import { OpenAIConverter } from './strategies/OpenAIConverter';
import { ClaudeConverter } from './strategies/ClaudeConverter';
import { GeminiConverter } from './strategies/GeminiConverter';


class ConverterFactoryClass {
    private converters = new Map<string, any>();
    private converterClasses = new Map<string, any>();

    constructor() {
        
        this.registerConverter(MODEL_PROTOCOL_PREFIX.OPENAI, OpenAIConverter);
        this.registerConverter(MODEL_PROTOCOL_PREFIX.CLAUDE, ClaudeConverter);
        this.registerConverter(MODEL_PROTOCOL_PREFIX.GEMINI, GeminiConverter);
        this.registerConverter(MODEL_PROTOCOL_PREFIX.GIGACHAT, OpenAIConverter); // GigaChat uses OpenAI format
        this.registerConverter(MODEL_PROTOCOL_PREFIX.DEEPSEEK, OpenAIConverter); // DeepSeek uses OpenAI format
        
    }

    registerConverter(protocolPrefix: string, ConverterClass: any) {
        this.converterClasses.set(protocolPrefix, ConverterClass);
    }

    getConverter(protocolPrefix: string) {
        logger.info(`[ConverterFactory] Getting converter for: ${protocolPrefix}`);
        
        
        if (this.converters.has(protocolPrefix)) {
            logger.info(`[ConverterFactory] Found in cache: ${protocolPrefix}`);
            return this.converters.get(protocolPrefix);
        }

        
        const ConverterClass = this.converterClasses.get(protocolPrefix);
        
        if (!ConverterClass) {
            logger.warn(`[ConverterFactory] No converter registered for protocol: ${protocolPrefix}`);
            logger.info(`[ConverterFactory] Registered protocols: ${Array.from(this.converterClasses.keys()).join(', ')}`);
            return null;
        }

        logger.info(`[ConverterFactory] Creating new converter for: ${protocolPrefix}`);
        const converter = new ConverterClass();
        
        
        this.converters.set(protocolPrefix, converter);

        return converter;
    }

    clearCache() {
        this.converters.clear();
    }
}


const ConverterFactory = new ConverterFactoryClass();


export function convertData(
    data: any,
    type: string,
    fromProvider: string,
    toProvider: string,
    model?: string,
    requestId?: string
): any {
    try {
        
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);

        
        if (toProtocol === MODEL_PROTOCOL_PREFIX.FORWARD || fromProtocol === MODEL_PROTOCOL_PREFIX.FORWARD) {
            logger.info(`[Convert] Target protocol is forward, skipping conversion`);
            return data;
        }

        
        const converter = ConverterFactory.getConverter(fromProtocol);

        if (!converter) {
            logger.warn(`[Convert] No converter found for ${fromProtocol}, returning original data`);
            return data;
        }

        
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
        return data; 
    }
}

