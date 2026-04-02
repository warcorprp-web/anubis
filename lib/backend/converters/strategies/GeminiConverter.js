import { v4 as uuidv4 } from "uuid";

import { BaseConverter } from "../BaseConverter.js";

import { checkAndAssignOrDefault, OPENAI_DEFAULT_MAX_TOKENS, OPENAI_DEFAULT_TEMPERATURE, OPENAI_DEFAULT_TOP_P, CLAUDE_DEFAULT_MAX_TOKENS, CLAUDE_DEFAULT_TEMPERATURE, CLAUDE_DEFAULT_TOP_P } from "../utils.js";

import { MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

import { generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted } from "../../providers/openai/openai-responses-core.mjs";

function remapFunctionCallArgs(toolName, args) {
  if (!args || typeof args !== "object") return args;
  const remappedArgs = {
    ...args
  };
  const toolNameLower = toolName.toLowerCase();
  if (toolName === "EnterPlanMode") {
    return {};
  }
  switch (toolNameLower) {
   case "grep":
   case "search":
   case "search_code_definitions":
   case "search_code_snippets":
    if (remappedArgs.description && !remappedArgs.pattern) {
      remappedArgs.pattern = remappedArgs.description;
      delete remappedArgs.description;
    }
    if (remappedArgs.query && !remappedArgs.pattern) {
      remappedArgs.pattern = remappedArgs.query;
      delete remappedArgs.query;
    }
    if (!remappedArgs.path) {
      if (remappedArgs.paths) {
        if (Array.isArray(remappedArgs.paths)) {
          remappedArgs.path = remappedArgs.paths[0] || ".";
        } else if (typeof remappedArgs.paths === "string") {
          remappedArgs.path = remappedArgs.paths;
        } else {
          remappedArgs.path = ".";
        }
        delete remappedArgs.paths;
      } else {
        remappedArgs.path = ".";
      }
    }
    break;

   case "glob":
    if (remappedArgs.description && !remappedArgs.pattern) {
      remappedArgs.pattern = remappedArgs.description;
      delete remappedArgs.description;
    }
    if (remappedArgs.query && !remappedArgs.pattern) {
      remappedArgs.pattern = remappedArgs.query;
      delete remappedArgs.query;
    }
    if (!remappedArgs.path) {
      if (remappedArgs.paths) {
        if (Array.isArray(remappedArgs.paths)) {
          remappedArgs.path = remappedArgs.paths[0] || ".";
        } else if (typeof remappedArgs.paths === "string") {
          remappedArgs.path = remappedArgs.paths;
        } else {
          remappedArgs.path = ".";
        }
        delete remappedArgs.paths;
      }
    }
    break;

   case "read":
    if (remappedArgs.path && !remappedArgs.file_path) {
      remappedArgs.file_path = remappedArgs.path;
      delete remappedArgs.path;
    }
    break;

   case "ls":
    if (!remappedArgs.path) {
      remappedArgs.path = ".";
    }
    break;

   default:
    if (!remappedArgs.path && remappedArgs.paths) {
      if (Array.isArray(remappedArgs.paths) && remappedArgs.paths.length === 1) {
        const pathValue = remappedArgs.paths[0];
        if (typeof pathValue === "string") {
          remappedArgs.path = pathValue;
        }
      }
    }
    break;
  }
  return remappedArgs;
}

function normalizeToolName(name) {
  if (!name) return name;
  const nameLower = name.toLowerCase();
  if (nameLower === "search") {
    return "Grep";
  }
  return name;
}

export class GeminiConverter extends BaseConverter {
  constructor() {
    super("gemini");
  }
  convertRequest(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIRequest(data);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeRequest(data);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesRequest(data);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexRequest(data);

     case MODEL_PROTOCOL_PREFIX.GROK:
      return this.toGrokRequest(data);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertResponse(data, targetProtocol, model) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexResponse(data, model);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertStreamChunk(chunk, targetProtocol, model) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexStreamChunk(chunk, model);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertModelList(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIModelList(data);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeModelList(data);

     default:
      return data;
    }
  }
  toOpenAIRequest(geminiRequest) {
    const openaiRequest = {
      messages: [],
      model: geminiRequest.model,
      max_tokens: checkAndAssignOrDefault(geminiRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
      temperature: checkAndAssignOrDefault(geminiRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
      top_p: checkAndAssignOrDefault(geminiRequest.top_p, OPENAI_DEFAULT_TOP_P)
    };
    if (geminiRequest.systemInstruction && Array.isArray(geminiRequest.systemInstruction.parts)) {
      const systemContent = this.processGeminiPartsToOpenAIContent(geminiRequest.systemInstruction.parts);
      if (systemContent) {
        openaiRequest.messages.push({
          role: "system",
          content: systemContent
        });
      }
    }
    if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
      geminiRequest.contents.forEach(content => {
        if (content && Array.isArray(content.parts)) {
          const openaiContent = this.processGeminiPartsToOpenAIContent(content.parts);
          if (openaiContent && openaiContent.length > 0) {
            const openaiRole = content.role === "model" ? "assistant" : content.role;
            openaiRequest.messages.push({
              role: openaiRole,
              content: openaiContent
            });
          }
        }
      });
    }
    return openaiRequest;
  }
  toOpenAIResponse(geminiResponse, model) {
    const content = this.processGeminiResponseContent(geminiResponse);
    const toolCalls = [];
    let finishReason = "stop";
    if (geminiResponse && geminiResponse.candidates) {
      for (const candidate of geminiResponse.candidates) {
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.id || `call_${uuidv4()}`,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: typeof part.functionCall.args === "string" ? part.functionCall.args : JSON.stringify(part.functionCall.args)
                }
              });
            }
          }
        }
      }
    }
    if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }
    const message = {
      role: "assistant",
      content: content
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    return {
      id: `chatcmpl-${uuidv4()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model: model,
      choices: [ {
        index: 0,
        message: message,
        finish_reason: finishReason
      } ],
      usage: geminiResponse.usageMetadata ? {
        prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
        completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
        total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0,
        cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0,
        prompt_tokens_details: {
          cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0
        },
        completion_tokens_details: {
          reasoning_tokens: geminiResponse.usageMetadata.thoughtsTokenCount || 0
        }
      } : {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        prompt_tokens_details: {
          cached_tokens: 0
        },
        completion_tokens_details: {
          reasoning_tokens: 0
        }
      }
    };
  }
  toOpenAIStreamChunk(geminiChunk, model) {
    if (!geminiChunk) return null;
    const candidate = geminiChunk.candidates?.[0];
    if (!candidate) return null;
    let content = "";
    const toolCalls = [];
    const parts = candidate.content?.parts;
    if (parts && Array.isArray(parts)) {
      for (const part of parts) {
        if (part.text) {
          content += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            index: toolCalls.length,
            id: part.functionCall.id || `call_${uuidv4()}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: typeof part.functionCall.args === "string" ? part.functionCall.args : JSON.stringify(part.functionCall.args)
            }
          });
        }
      }
    }
    let finishReason = null;
    if (candidate.finishReason) {
      const finishReasonMap = {
        FINISH_REASON_UNSPECIFIED: "stop",
        STOP: "stop",
        MAX_TOKENS: "length",
        SAFETY: "content_filter",
        RECITATION: "content_filter",
        OTHER: "stop",
        BLOCKLIST: "content_filter",
        PROHIBITED_CONTENT: "content_filter",
        SPII: "content_filter",
        MALFORMED_FUNCTION_CALL: "stop",
        MODEL_ARMOR: "content_filter"
      };
      finishReason = finishReasonMap[candidate.finishReason] || "stop";
    }
    if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }
    const delta = {};
    if (content) delta.content = content;
    if (toolCalls.length > 0) delta.tool_calls = toolCalls;
    if (Object.keys(delta).length === 0 && !finishReason) {
      return null;
    }
    const chunk = {
      id: `chatcmpl-${uuidv4()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1e3),
      model: model,
      choices: [ {
        index: 0,
        delta: delta,
        finish_reason: finishReason
      } ]
    };
    if (geminiChunk.usageMetadata) {
      chunk.usage = {
        prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
        completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
        total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
        cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
        prompt_tokens_details: {
          cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
        },
        completion_tokens_details: {
          reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
        }
      };
    }
    return chunk;
  }
  toOpenAIModelList(geminiModels) {
    return {
      object: "list",
      data: geminiModels.models.map(m => {
        const modelId = m.name.startsWith("models/") ? m.name.substring(7) : m.name;
        return {
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1e3),
          owned_by: "google",
          display_name: m.displayName || modelId
        };
      })
    };
  }
  processGeminiPartsToOpenAIContent(parts) {
    if (!parts || !Array.isArray(parts)) return "";
    const contentArray = [];
    parts.forEach(part => {
      if (!part) return;
      if (typeof part.text === "string") {
        contentArray.push({
          type: "text",
          text: part.text
        });
      }
      if (part.inlineData) {
        const {mimeType: mimeType, data: data} = part.inlineData;
        if (mimeType && data) {
          contentArray.push({
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${data}`
            }
          });
        }
      }
      if (part.fileData) {
        const {mimeType: mimeType, fileUri: fileUri} = part.fileData;
        if (mimeType && fileUri) {
          if (mimeType.startsWith("image/")) {
            contentArray.push({
              type: "image_url",
              image_url: {
                url: fileUri
              }
            });
          } else if (mimeType.startsWith("audio/")) {
            contentArray.push({
              type: "text",
              text: `[Audio file: ${fileUri}]`
            });
          }
        }
      }
    });
    return contentArray.length === 1 && contentArray[0].type === "text" ? contentArray[0].text : contentArray;
  }
  processGeminiResponseContent(geminiResponse) {
    if (!geminiResponse || !geminiResponse.candidates) return "";
    const contents = [];
    geminiResponse.candidates.forEach(candidate => {
      if (candidate.content && candidate.content.parts) {
        candidate.content.parts.forEach(part => {
          if (part.text) {
            contents.push(part.text);
          }
        });
      }
    });
    return contents.join("\n");
  }
  toClaudeRequest(geminiRequest) {
    const claudeRequest = {
      model: geminiRequest.model || "claude-3-opus",
      messages: [],
      max_tokens: checkAndAssignOrDefault(geminiRequest.generationConfig?.maxOutputTokens, CLAUDE_DEFAULT_MAX_TOKENS),
      temperature: checkAndAssignOrDefault(geminiRequest.generationConfig?.temperature, CLAUDE_DEFAULT_TEMPERATURE),
      top_p: checkAndAssignOrDefault(geminiRequest.generationConfig?.topP, CLAUDE_DEFAULT_TOP_P)
    };
    if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
      const systemText = geminiRequest.systemInstruction.parts.filter(p => p.text).map(p => p.text).join("\n");
      if (systemText) {
        claudeRequest.system = systemText;
      }
    }
    if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
      geminiRequest.contents.forEach(content => {
        if (!content || !content.parts) return;
        const role = content.role === "model" ? "assistant" : "user";
        const claudeContent = this.processGeminiPartsToClaudeContent(content.parts);
        if (claudeContent.length > 0) {
          claudeRequest.messages.push({
            role: role,
            content: claudeContent
          });
        }
      });
    }
    if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
      claudeRequest.tools = geminiRequest.tools[0].functionDeclarations.map(func => ({
        name: func.name,
        description: func.description || "",
        input_schema: func.parameters || {
          type: "object",
          properties: {}
        }
      }));
    }
    return claudeRequest;
  }
  toClaudeResponse(geminiResponse, model) {
    if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
      return {
        id: `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
          output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0
        }
      };
    }
    const candidate = geminiResponse.candidates[0];
    const {content: content, hasToolUse: hasToolUse} = this.processGeminiResponseToClaudeContent(geminiResponse);
    const finishReason = candidate.finishReason;
    let stopReason = "end_turn";
    if (hasToolUse) {
      stopReason = "tool_use";
    } else if (finishReason) {
      switch (finishReason) {
       case "STOP":
        stopReason = "end_turn";
        break;

       case "MAX_TOKENS":
        stopReason = "max_tokens";
        break;

       case "SAFETY":
        stopReason = "safety";
        break;

       case "RECITATION":
        stopReason = "recitation";
        break;

       case "OTHER":
        stopReason = "other";
        break;

       default:
        stopReason = "end_turn";
      }
    }
    return {
      id: `msg_${uuidv4()}`,
      type: "message",
      role: "assistant",
      content: content,
      model: model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0,
        output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
      }
    };
  }
  toClaudeStreamChunk(geminiChunk, model) {
    if (!geminiChunk) return null;
    if (typeof geminiChunk === "object" && !Array.isArray(geminiChunk)) {
      const candidate = geminiChunk.candidates?.[0];
      if (candidate) {
        const parts = candidate.content?.parts;
        if (parts && Array.isArray(parts)) {
          const results = [];
          let hasToolUse = false;
          for (const part of parts) {
            if (!part) continue;
            if (typeof part.text === "string") {
              if (part.thought === true) {
                const thinkingResult = {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "thinking_delta",
                    thinking: part.text
                  }
                };
                results.push(thinkingResult);
                const rawSignature = part.thoughtSignature || part.thought_signature;
                if (rawSignature) {
                  let signature = rawSignature;
                  try {
                    const decoded = Buffer.from(signature, "base64").toString("utf-8");
                    if (decoded && decoded.length > 0 && !decoded.includes("�")) {
                      signature = decoded;
                    }
                  } catch (e) {}
                  results.push({
                    type: "content_block_delta",
                    index: 0,
                    delta: {
                      type: "signature_delta",
                      signature: signature
                    }
                  });
                }
              } else {
                results.push({
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: part.text
                  }
                });
              }
            }
            if (part.functionCall) {
              hasToolUse = true;
              const toolName = normalizeToolName(part.functionCall.name);
              const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
              const toolId = part.functionCall.id || `${toolName}-${uuidv4().split("-")[0]}`;
              results.push({
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: toolId,
                  name: toolName,
                  input: {}
                }
              });
              results.push({
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(remappedArgs)
                }
              });
            }
          }
          if (hasToolUse && candidate.finishReason) {
            const messageDelta = {
              type: "message_delta",
              delta: {
                stop_reason: "tool_use"
              }
            };
            if (geminiChunk.usageMetadata) {
              messageDelta.usage = {
                input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
                output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0
              };
            }
            results.push(messageDelta);
          }
          if (results.length > 1) {
            return results;
          } else if (results.length === 1) {
            return results[0];
          }
        }
        if (candidate.finishReason) {
          const result = {
            type: "message_delta",
            delta: {
              stop_reason: candidate.finishReason === "STOP" ? "end_turn" : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : candidate.finishReason.toLowerCase()
            }
          };
          if (geminiChunk.usageMetadata) {
            result.usage = {
              input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
              output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
              prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
              completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
              total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
              cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
            };
          }
          return result;
        }
      }
    }
    if (typeof geminiChunk === "string") {
      return {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: geminiChunk
        }
      };
    }
    return null;
  }
  toClaudeModelList(geminiModels) {
    return {
      models: geminiModels.models.map(m => ({
        name: m.name.startsWith("models/") ? m.name.substring(7) : m.name,
        description: ""
      }))
    };
  }
  processGeminiPartsToClaudeContent(parts) {
    if (!parts || !Array.isArray(parts)) return [];
    const content = [];
    parts.forEach(part => {
      if (!part) return;
      if (part.text) {
        if (part.thought === true) {
          const thinkingBlock = {
            type: "thinking",
            thinking: part.text
          };
          const rawSignature = part.thoughtSignature || part.thought_signature;
          if (rawSignature) {
            let signature = rawSignature;
            try {
              const decoded = Buffer.from(signature, "base64").toString("utf-8");
              if (decoded && decoded.length > 0 && !decoded.includes("�")) {
                signature = decoded;
              }
            } catch (e) {}
            thinkingBlock.signature = signature;
          }
          content.push(thinkingBlock);
        } else {
          content.push({
            type: "text",
            text: part.text
          });
        }
      }
      if (part.inlineData) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.inlineData.mimeType,
            data: part.inlineData.data
          }
        });
      }
      if (part.functionCall) {
        const toolName = normalizeToolName(part.functionCall.name);
        const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
        const toolUseBlock = {
          type: "tool_use",
          id: part.functionCall.id || `${toolName}-${uuidv4().split("-")[0]}`,
          name: toolName,
          input: remappedArgs
        };
        const rawSignature = part.thoughtSignature || part.thought_signature;
        if (rawSignature) {
          let signature = rawSignature;
          try {
            const decoded = Buffer.from(signature, "base64").toString("utf-8");
            if (decoded && decoded.length > 0 && !decoded.includes("�")) {
              signature = decoded;
            }
          } catch (e) {}
          toolUseBlock.signature = signature;
        }
        content.push(toolUseBlock);
      }
      if (part.functionResponse) {
        let responseContent = part.functionResponse.response;
        if (responseContent && typeof responseContent === "object" && responseContent.result !== undefined) {
          responseContent = responseContent.result;
        }
        content.push({
          type: "tool_result",
          tool_use_id: part.functionResponse.name,
          content: typeof responseContent === "string" ? responseContent : JSON.stringify(responseContent)
        });
      }
    });
    return content;
  }
  processGeminiResponseToClaudeContent(geminiResponse) {
    if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
      return {
        content: [],
        hasToolUse: false
      };
    }
    const content = [];
    let hasToolUse = false;
    for (const candidate of geminiResponse.candidates) {
      if (candidate.finishReason && candidate.finishReason !== "STOP") {
        if (candidate.finishMessage) {
          content.push({
            type: "text",
            text: `Error: ${candidate.finishMessage}`
          });
        }
        continue;
      }
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            if (part.thought === true) {
              const thinkingBlock = {
                type: "thinking",
                thinking: part.text
              };
              const rawSignature = part.thoughtSignature || part.thought_signature;
              if (rawSignature) {
                let signature = rawSignature;
                try {
                  const decoded = Buffer.from(signature, "base64").toString("utf-8");
                  if (decoded && decoded.length > 0 && !decoded.includes("�")) {
                    signature = decoded;
                  }
                } catch (e) {}
                thinkingBlock.signature = signature;
              }
              content.push(thinkingBlock);
            } else {
              content.push({
                type: "text",
                text: part.text
              });
            }
          } else if (part.inlineData) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.inlineData.mimeType,
                data: part.inlineData.data
              }
            });
          } else if (part.functionCall) {
            hasToolUse = true;
            const toolName = normalizeToolName(part.functionCall.name);
            const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
            const toolUseBlock = {
              type: "tool_use",
              id: part.functionCall.id || `${toolName}-${uuidv4().split("-")[0]}`,
              name: toolName,
              input: remappedArgs
            };
            const rawSignature = part.thoughtSignature || part.thought_signature;
            if (rawSignature) {
              let signature = rawSignature;
              try {
                const decoded = Buffer.from(signature, "base64").toString("utf-8");
                if (decoded && decoded.length > 0 && !decoded.includes("�")) {
                  signature = decoded;
                }
              } catch (e) {}
              toolUseBlock.signature = signature;
            }
            content.push(toolUseBlock);
          }
        }
      }
    }
    return {
      content: content,
      hasToolUse: hasToolUse
    };
  }
  toOpenAIResponsesRequest(geminiRequest) {
    const responsesRequest = {
      model: geminiRequest.model,
      instructions: "",
      input: [],
      stream: geminiRequest.stream || false,
      max_output_tokens: geminiRequest.generationConfig?.maxOutputTokens,
      temperature: geminiRequest.generationConfig?.temperature,
      top_p: geminiRequest.generationConfig?.topP
    };
    if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
      responsesRequest.instructions = geminiRequest.systemInstruction.parts.filter(p => p.text).map(p => p.text).join("\n");
    }
    if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
      geminiRequest.contents.forEach(content => {
        const role = content.role === "model" ? "assistant" : "user";
        const parts = content.parts || [];
        parts.forEach(part => {
          if (part.text) {
            responsesRequest.input.push({
              type: "message",
              role: role,
              content: [ {
                type: role === "assistant" ? "output_text" : "input_text",
                text: part.text
              } ]
            });
          }
          if (part.functionCall) {
            responsesRequest.input.push({
              type: "function_call",
              call_id: part.functionCall.id || `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
              name: part.functionCall.name,
              arguments: typeof part.functionCall.args === "string" ? part.functionCall.args : JSON.stringify(part.functionCall.args)
            });
          }
          if (part.functionResponse) {
            responsesRequest.input.push({
              type: "function_call_output",
              call_id: part.functionResponse.name,
              output: typeof part.functionResponse.response?.result === "string" ? part.functionResponse.response.result : JSON.stringify(part.functionResponse.response || {})
            });
          }
          if (part.inlineData) {
            responsesRequest.input.push({
              type: "message",
              role: role,
              content: [ {
                type: "input_image",
                image_url: {
                  url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                }
              } ]
            });
          }
        });
      });
    }
    if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
      responsesRequest.tools = geminiRequest.tools[0].functionDeclarations.map(fn => ({
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || fn.parametersJsonSchema || {
          type: "object",
          properties: {}
        }
      }));
    }
    return responsesRequest;
  }
  toOpenAIResponsesResponse(geminiResponse, model) {
    const content = this.processGeminiResponseContent(geminiResponse);
    const textContent = typeof content === "string" ? content : JSON.stringify(content);
    let output = [];
    output.push({
      id: `msg_${uuidv4().replace(/-/g, "")}`,
      summary: [],
      type: "message",
      role: "assistant",
      status: "completed",
      content: [ {
        annotations: [],
        logprobs: [],
        text: textContent,
        type: "output_text"
      } ]
    });
    return {
      background: false,
      created_at: Math.floor(Date.now() / 1e3),
      error: null,
      id: `resp_${uuidv4().replace(/-/g, "")}`,
      incomplete_details: null,
      max_output_tokens: null,
      max_tool_calls: null,
      metadata: {},
      model: model,
      object: "response",
      output: output,
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: null,
      reasoning: {},
      safety_identifier: "user-" + uuidv4().replace(/-/g, ""),
      service_tier: "default",
      status: "completed",
      store: false,
      temperature: 1,
      text: {
        format: {
          type: "text"
        }
      },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        input_tokens_details: {
          cached_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0
        },
        output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
        output_tokens_details: {
          reasoning_tokens: geminiResponse.usageMetadata?.thoughtsTokenCount || 0
        },
        total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
      },
      user: null
    };
  }
  toOpenAIResponsesStreamChunk(geminiChunk, model, requestId = null) {
    if (!geminiChunk) return [];
    const responseId = requestId || `resp_${uuidv4().replace(/-/g, "")}`;
    const events = [];
    if (typeof geminiChunk === "object" && !Array.isArray(geminiChunk)) {
      const candidate = geminiChunk.candidates?.[0];
      if (candidate) {
        const parts = candidate.content?.parts;
        if (candidate.content?.role === "model" && parts && parts.length > 0) {
          const hasContent = parts.some(part => part && typeof part.text === "string" && part.text.length > 0);
          if (hasContent) {
            events.push(generateResponseCreated(responseId, model || "unknown"), generateResponseInProgress(responseId), generateOutputItemAdded(responseId), generateContentPartAdded(responseId));
          }
        }
        if (parts && Array.isArray(parts)) {
          const textParts = parts.filter(part => part && typeof part.text === "string");
          if (textParts.length > 0) {
            const text = textParts.map(part => part.text).join("");
            events.push({
              delta: text,
              item_id: `msg_${uuidv4().replace(/-/g, "")}`,
              output_index: 0,
              sequence_number: 3,
              type: "response.output_text.delta"
            });
          }
        }
        if (candidate.finishReason) {
          events.push(generateOutputTextDone(responseId), generateContentPartDone(responseId), generateOutputItemDone(responseId), generateResponseCompleted(responseId));
          if (geminiChunk.usageMetadata && events.length > 0) {
            const lastEvent = events[events.length - 1];
            if (lastEvent.response) {
              lastEvent.response.usage = {
                input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                input_tokens_details: {
                  cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                },
                output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                output_tokens_details: {
                  reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
                },
                total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0
              };
            }
          }
        }
      }
    }
    if (typeof geminiChunk === "string") {
      events.push({
        delta: geminiChunk,
        item_id: `msg_${uuidv4().replace(/-/g, "")}`,
        output_index: 0,
        sequence_number: 3,
        type: "response.output_text.delta"
      });
    }
    return events;
  }
  toCodexRequest(geminiRequest) {
    const openaiRequest = this.toOpenAIRequest(geminiRequest);
    const codexRequest = {
      model: openaiRequest.model,
      instructions: "",
      input: [],
      stream: geminiRequest.stream || false,
      store: false,
      reasoning: {
        effort: "medium",
        summary: "auto"
      },
      parallel_tool_calls: true,
      include: [ "reasoning.encrypted_content" ]
    };
    if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
      codexRequest.instructions = geminiRequest.systemInstruction.parts.filter(p => p.text).map(p => p.text).join("\n");
    }
    if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
      const pendingCallIDs = [];
      geminiRequest.contents.forEach(content => {
        const role = content.role === "model" ? "assistant" : "user";
        const parts = content.parts || [];
        parts.forEach(part => {
          if (part.text) {
            codexRequest.input.push({
              type: "message",
              role: role,
              content: [ {
                type: role === "assistant" ? "output_text" : "input_text",
                text: part.text
              } ]
            });
          }
          if (part.functionCall) {
            const callId = `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
            pendingCallIDs.push(callId);
            codexRequest.input.push({
              type: "function_call",
              call_id: callId,
              name: part.functionCall.name,
              arguments: typeof part.functionCall.args === "string" ? part.functionCall.args : JSON.stringify(part.functionCall.args)
            });
          }
          if (part.functionResponse) {
            const callId = pendingCallIDs.shift() || `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
            codexRequest.input.push({
              type: "function_call_output",
              call_id: callId,
              output: typeof part.functionResponse.response?.result === "string" ? part.functionResponse.response.result : JSON.stringify(part.functionResponse.response || {})
            });
          }
        });
      });
    }
    if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
      codexRequest.tools = geminiRequest.tools[0].functionDeclarations.map(fn => ({
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || {
          type: "object",
          properties: {}
        }
      }));
    }
    return codexRequest;
  }
  toGrokRequest(geminiRequest) {
    const openaiRequest = this.toOpenAIRequest(geminiRequest);
    return {
      ...openaiRequest,
      _isConverted: true
    };
  }
  toCodexResponse(geminiResponse, model) {
    const parts = [];
    if (geminiResponse.response?.output) {
      geminiResponse.response.output.forEach(item => {
        if (item.type === "message" && item.content) {
          const textPart = item.content.find(c => c.type === "output_text");
          if (textPart) parts.push({
            text: textPart.text
          });
        } else if (item.type === "reasoning" && item.summary) {
          const textPart = item.summary.find(c => c.type === "summary_text");
          if (textPart) parts.push({
            text: textPart.text,
            thought: true
          });
        } else if (item.type === "function_call") {
          parts.push({
            functionCall: {
              name: item.name,
              args: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments
            }
          });
        }
      });
    }
    return {
      candidates: [ {
        content: {
          role: "model",
          parts: parts
        },
        finishReason: "STOP"
      } ],
      usageMetadata: {
        promptTokenCount: geminiResponse.response?.usage?.input_tokens || 0,
        candidatesTokenCount: geminiResponse.response?.usage?.output_tokens || 0,
        totalTokenCount: geminiResponse.response?.usage?.total_tokens || 0
      },
      modelVersion: model,
      responseId: geminiResponse.response?.id
    };
  }
  toCodexStreamChunk(codexChunk, model) {
    const type = codexChunk.type;
    const resId = codexChunk.response?.id || "default";
    const template = {
      candidates: [ {
        content: {
          role: "model",
          parts: []
        }
      } ],
      modelVersion: model,
      responseId: resId
    };
    if (type === "response.reasoning_summary_text.delta") {
      template.candidates[0].content.parts.push({
        text: codexChunk.delta,
        thought: true
      });
      return template;
    }
    if (type === "response.output_text.delta") {
      template.candidates[0].content.parts.push({
        text: codexChunk.delta
      });
      return template;
    }
    if (type === "response.output_item.done" && codexChunk.item?.type === "function_call") {
      template.candidates[0].content.parts.push({
        functionCall: {
          name: codexChunk.item.name,
          args: typeof codexChunk.item.arguments === "string" ? JSON.parse(codexChunk.item.arguments) : codexChunk.item.arguments
        }
      });
      return template;
    }
    if (type === "response.completed") {
      template.candidates[0].finishReason = "STOP";
      template.usageMetadata = {
        promptTokenCount: codexChunk.response.usage?.input_tokens || 0,
        candidatesTokenCount: codexChunk.response.usage?.output_tokens || 0,
        totalTokenCount: codexChunk.response.usage?.total_tokens || 0
      };
      return template;
    }
    return null;
  }
}

export default GeminiConverter;