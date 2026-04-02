/**
 * Base Converter class (ported from BaseConverter.js)
 * All protocol converters inherit from this
 */

/**
 * Abstract base converter class (точь-в-точь как в оригинале)
 */
export abstract class BaseConverter {
    protected protocolName: string;

    constructor(protocolName: string) {
        if (new.target === BaseConverter) {
            throw new Error('BaseConverter is abstract and cannot be instantiated');
        }
        this.protocolName = protocolName;
    }

    /**
     * Convert request (точь-в-точь как в оригинале)
     */
    abstract convertRequest(data: any, targetProtocol: string): any;

    /**
     * Convert response (точь-в-точь как в оригинале)
     */
    abstract convertResponse(data: any, targetProtocol: string, model?: string): any;

    /**
     * Convert stream chunk (точь-в-точь как в оригинале)
     */
    abstract convertStreamChunk(chunk: any, targetProtocol: string, model?: string, requestId?: string): any;

    /**
     * Convert model list (точь-в-точь как в оригинале)
     */
    abstract convertModelList(data: any, targetProtocol: string): any;

    /**
     * Get protocol name (точь-в-точь как в оригинале)
     */
    getProtocolName(): string {
        return this.protocolName;
    }
}
