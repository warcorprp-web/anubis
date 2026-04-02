export class BaseConverter {
  constructor(protocolName) {
    if (new.target === BaseConverter) {
      throw new Error("BaseConverter是抽象类，不能直接实例化");
    }
    this.protocolName = protocolName;
  }
  convertRequest(data, targetProtocol) {
    throw new Error("convertRequest方法必须被子类实现");
  }
  convertResponse(data, targetProtocol, model) {
    throw new Error("convertResponse方法必须被子类实现");
  }
  convertStreamChunk(chunk, targetProtocol, model) {
    throw new Error("convertStreamChunk方法必须被子类实现");
  }
  convertModelList(data, targetProtocol) {
    throw new Error("convertModelList方法必须被子类实现");
  }
  getProtocolName() {
    return this.protocolName;
  }
}

export class ContentProcessor {
  process(content) {
    throw new Error("process方法必须被子类实现");
  }
}

export class ToolProcessor {
  processToolDefinitions(tools) {
    throw new Error("processToolDefinitions方法必须被子类实现");
  }
  processToolCall(toolCall) {
    throw new Error("processToolCall方法必须被子类实现");
  }
  processToolResult(toolResult) {
    throw new Error("processToolResult方法必须被子类实现");
  }
}