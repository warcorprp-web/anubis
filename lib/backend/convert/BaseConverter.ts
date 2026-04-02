


export abstract class BaseConverter {
    protected protocolName: string;

    constructor(protocolName: string) {
        if (new.target === BaseConverter) {
            throw new Error('BaseConverter is abstract and cannot be instantiated');
        }
        this.protocolName = protocolName;
    }

    
    abstract convertRequest(data: any, targetProtocol: string): any;

    
    abstract convertResponse(data: any, targetProtocol: string, model?: string): any;

    
    abstract convertStreamChunk(chunk: any, targetProtocol: string, model?: string, requestId?: string): any;

    
    abstract convertModelList(data: any, targetProtocol: string): any;

    
    getProtocolName(): string {
        return this.protocolName;
    }
}
