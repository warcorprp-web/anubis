import { v4 as uuidv4 } from "uuid";

import logger from "../../utils/logger.js";

import { BaseConverter } from "../BaseConverter.js";

import { checkAndAssignOrDefault, cleanJsonSchemaProperties as cleanJsonSchema, determineReasoningEffortFromBudget, OPENAI_DEFAULT_MAX_TOKENS, OPENAI_DEFAULT_TEMPERATURE, OPENAI_DEFAULT_TOP_P, GEMINI_DEFAULT_MAX_TOKENS, GEMINI_DEFAULT_TEMPERATURE, GEMINI_DEFAULT_TOP_P, GEMINI_DEFAULT_INPUT_TOKEN_LIMIT, GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT } from "../utils.js";

import { MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

import { generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted, generateOutputTextDelta, streamStateManager, startToolCall, finishToolCall, generateFunctionCallArgsDelta, generateFunctionCallArgsDone, generateFunctionCallOutputItemDone } from "../../providers/openai/openai-responses-core.mjs";

export class ClaudeConverter extends BaseConverter {
  constructor() {
    super("claude");
  }
  convertRequest(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIRequest(data);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiRequest(data);

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

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexResponse(data, model);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertStreamChunk(chunk, targetProtocol, model, requestId) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesStreamChunk(chunk, model, requestId);

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

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiModelList(data);

     default:
      return data;
    }
  }
  toOpenAIRequest(claudeRequest) {
    const openaiMessages = [];
    let systemMessageContent = "";
    if (claudeRequest.system) {
      systemMessageContent = claudeRequest.system;
    }
    if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
      const tempOpenAIMessages = [];
      for (const msg of claudeRequest.messages) {
        const role = msg.role;
        if (role === "user" && Array.isArray(msg.content)) {
          const hasToolResult = msg.content.some(item => item && typeof item === "object" && item.type === "tool_result");
          if (hasToolResult) {
            for (const item of msg.content) {
              if (item && typeof item === "object" && item.type === "tool_result") {
                const toolUseId = item.tool_use_id || item.id || "";
                let contentStr = item.content || "";
                if (typeof contentStr === "object") {
                  contentStr = JSON.stringify(contentStr);
                } else {
                  contentStr = String(contentStr);
                }
                tempOpenAIMessages.push({
                  role: "tool",
                  tool_call_id: toolUseId,
                  content: contentStr
                });
              }
            }
            continue;
          }
        }
        if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
          const firstPart = msg.content[0];
          if (firstPart.type === "tool_use") {
            const funcName = firstPart.name || "";
            const funcArgs = firstPart.input || {};
            tempOpenAIMessages.push({
              role: "assistant",
              content: "",
              tool_calls: [ {
                id: firstPart.id || `call_${funcName}_1`,
                type: "function",
                function: {
                  name: funcName,
                  arguments: JSON.stringify(funcArgs)
                },
                index: firstPart.index || 0
              } ]
            });
            continue;
          }
        }
        const contentConverted = this.processClaudeContentToOpenAIContent(msg.content || "");
        if (contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0)) {
          tempOpenAIMessages.push({
            role: role,
            content: contentConverted
          });
        }
      }
      const validatedMessages = [];
      for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
        const m = tempOpenAIMessages[idx];
        if (m.role === "assistant" && m.tool_calls) {
          const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
          let unmatched = new Set(callIds);
          for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
            const later = tempOpenAIMessages[laterIdx];
            if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
              unmatched.delete(later.tool_call_id);
            }
            if (unmatched.size === 0) break;
          }
          if (unmatched.size > 0) {
            m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
            if (m.tool_calls.length === 0) {
              delete m.tool_calls;
              if (m.content === null) m.content = "";
            }
          }
        }
        validatedMessages.push(m);
      }
      openaiMessages.push(...validatedMessages);
    }
    const openaiRequest = {
      model: claudeRequest.model,
      messages: openaiMessages,
      max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
      temperature: checkAndAssignOrDefault(claudeRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
      top_p: checkAndAssignOrDefault(claudeRequest.top_p, OPENAI_DEFAULT_TOP_P),
      stream: claudeRequest.stream
    };
    if (claudeRequest.tools) {
      const openaiTools = [];
      for (const tool of claudeRequest.tools) {
        openaiTools.push({
          type: "function",
          function: {
            name: tool.name || "",
            description: tool.description || "",
            parameters: cleanJsonSchema(tool.input_schema || {})
          }
        });
      }
      openaiRequest.tools = openaiTools;
      openaiRequest.tool_choice = "auto";
    }
    if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
      const budgetTokens = claudeRequest.thinking.budget_tokens;
      const reasoningEffort = determineReasoningEffortFromBudget(budgetTokens);
      openaiRequest.reasoning_effort = reasoningEffort;
      let maxCompletionTokens = null;
      if (claudeRequest.max_tokens !== undefined) {
        maxCompletionTokens = claudeRequest.max_tokens;
        delete openaiRequest.max_tokens;
      } else {
        const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
        if (envMaxTokens) {
          try {
            maxCompletionTokens = parseInt(envMaxTokens, 10);
          } catch (e) {
            logger.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}'`);
          }
        }
        if (!envMaxTokens) {
          throw new Error("For OpenAI reasoning models, max_completion_tokens is required.");
        }
      }
      openaiRequest.max_completion_tokens = maxCompletionTokens;
    }
    if (systemMessageContent) {
      let stringifiedSystemMessageContent = systemMessageContent;
      if (Array.isArray(systemMessageContent)) {
        stringifiedSystemMessageContent = systemMessageContent.map(item => typeof item === "string" ? item : item.text).join("\n");
      }
      openaiRequest.messages.unshift({
        role: "system",
        content: stringifiedSystemMessageContent
      });
    }
    return openaiRequest;
  }
  toOpenAIResponse(claudeResponse, model) {
    if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
      return {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1e3),
        model: model,
        choices: [ {
          index: 0,
          message: {
            role: "assistant",
            content: ""
          },
          finish_reason: "stop"
        } ],
        usage: {
          prompt_tokens: claudeResponse.usage?.input_tokens || 0,
          completion_tokens: claudeResponse.usage?.output_tokens || 0,
          total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
        }
      };
    }
    let reasoningContent = "";
    if (Array.isArray(claudeResponse.content)) {
      for (const block of claudeResponse.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking") {
          reasoningContent += block.thinking ?? block.text ?? "";
        }
      }
    }
    const hasToolUse = claudeResponse.content.some(block => block && block.type === "tool_use");
    let message = {
      role: "assistant",
      content: null
    };
    if (hasToolUse) {
      const toolCalls = [];
      let textContent = "";
      for (const block of claudeResponse.content) {
        if (!block) continue;
        if (block.type === "text") {
          textContent += block.text || "";
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${block.name}_${Date.now()}`,
            type: "function",
            function: {
              name: block.name || "",
              arguments: JSON.stringify(block.input || {})
            }
          });
        }
      }
      message.content = textContent || null;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
    } else {
      message.content = this.processClaudeResponseContent(claudeResponse.content);
    }
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    let finishReason = "stop";
    if (claudeResponse.stop_reason === "end_turn") {
      finishReason = "stop";
    } else if (claudeResponse.stop_reason === "max_tokens") {
      finishReason = "length";
    } else if (claudeResponse.stop_reason === "tool_use") {
      finishReason = "tool_calls";
    } else if (claudeResponse.stop_reason) {
      finishReason = claudeResponse.stop_reason;
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
      usage: {
        prompt_tokens: claudeResponse.usage?.input_tokens || 0,
        completion_tokens: claudeResponse.usage?.output_tokens || 0,
        total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
        cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
        }
      }
    };
  }
  toOpenAIStreamChunk(claudeChunk, model) {
    if (!claudeChunk) return null;
    const chunkId = `chatcmpl-${uuidv4()}`;
    const timestamp = Math.floor(Date.now() / 1e3);
    if (claudeChunk.type === "message_start") {
      return {
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model,
        system_fingerprint: "",
        choices: [ {
          index: 0,
          delta: {
            role: "assistant",
            content: ""
          },
          finish_reason: null
        } ],
        usage: {
          prompt_tokens: claudeChunk.message?.usage?.input_tokens || 0,
          completion_tokens: 0,
          total_tokens: claudeChunk.message?.usage?.input_tokens || 0,
          cached_tokens: claudeChunk.message?.usage?.cache_read_input_tokens || 0
        }
      };
    }
    if (claudeChunk.type === "content_block_start") {
      const contentBlock = claudeChunk.content_block;
      if (contentBlock && contentBlock.type === "tool_use") {
        return {
          id: chunkId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: model,
          system_fingerprint: "",
          choices: [ {
            index: 0,
            delta: {
              tool_calls: [ {
                index: claudeChunk.index || 0,
                id: contentBlock.id,
                type: "function",
                function: {
                  name: contentBlock.name,
                  arguments: ""
                }
              } ]
            },
            finish_reason: null
          } ]
        };
      }
      return {
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model,
        system_fingerprint: "",
        choices: [ {
          index: 0,
          delta: {
            content: ""
          },
          finish_reason: null
        } ]
      };
    }
    if (claudeChunk.type === "content_block_delta") {
      const delta = claudeChunk.delta;
      if (delta && delta.type === "text_delta") {
        return {
          id: chunkId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: model,
          system_fingerprint: "",
          choices: [ {
            index: 0,
            delta: {
              content: delta.text || ""
            },
            finish_reason: null
          } ]
        };
      }
      if (delta && delta.type === "thinking_delta") {
        return {
          id: chunkId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: model,
          system_fingerprint: "",
          choices: [ {
            index: 0,
            delta: {
              reasoning_content: delta.thinking || ""
            },
            finish_reason: null
          } ]
        };
      }
      if (delta && delta.type === "input_json_delta") {
        return {
          id: chunkId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: model,
          system_fingerprint: "",
          choices: [ {
            index: 0,
            delta: {
              tool_calls: [ {
                index: claudeChunk.index || 0,
                function: {
                  arguments: delta.partial_json || ""
                }
              } ]
            },
            finish_reason: null
          } ]
        };
      }
    }
    if (claudeChunk.type === "content_block_stop") {
      return {
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model,
        system_fingerprint: "",
        choices: [ {
          index: 0,
          delta: {},
          finish_reason: null
        } ]
      };
    }
    if (claudeChunk.type === "message_delta") {
      const stopReason = claudeChunk.delta?.stop_reason;
      const finishReason = stopReason === "end_turn" ? "stop" : stopReason === "max_tokens" ? "length" : stopReason === "tool_use" ? "tool_calls" : stopReason || "stop";
      const chunk = {
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model,
        system_fingerprint: "",
        choices: [ {
          index: 0,
          delta: {},
          finish_reason: finishReason
        } ]
      };
      if (claudeChunk.usage) {
        chunk.usage = {
          prompt_tokens: claudeChunk.usage.input_tokens || 0,
          completion_tokens: claudeChunk.usage.output_tokens || 0,
          total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
          cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0,
          prompt_tokens_details: {
            cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
          }
        };
      }
      return chunk;
    }
    if (claudeChunk.type === "message_stop") {
      return null;
    }
    if (typeof claudeChunk === "string") {
      return {
        id: chunkId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model,
        system_fingerprint: "",
        choices: [ {
          index: 0,
          delta: {
            content: claudeChunk
          },
          finish_reason: null
        } ]
      };
    }
    return null;
  }
  toOpenAIModelList(claudeModels) {
    return {
      object: "list",
      data: claudeModels.models.map(m => {
        const modelId = m.id || m.name;
        return {
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1e3),
          owned_by: "anthropic",
          display_name: modelId
        };
      })
    };
  }
  toGeminiModelList(claudeModels) {
    const models = claudeModels.models || [];
    return {
      models: models.map(m => ({
        name: `models/${m.id || m.name}`,
        version: m.version || "1.0.0",
        displayName: m.displayName || m.id || m.name,
        description: m.description || `A generative model for text and chat generation. ID: ${m.id || m.name}`,
        inputTokenLimit: m.inputTokenLimit || GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
        outputTokenLimit: m.outputTokenLimit || GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
        supportedGenerationMethods: m.supportedGenerationMethods || [ "generateContent", "streamGenerateContent" ]
      }))
    };
  }
  processClaudeContentToOpenAIContent(content) {
    if (!content) return [];
    if (typeof content === "string") {
      return [ {
        type: "text",
        text: content
      } ];
    }
    if (!Array.isArray(content)) return [];
    const contentArray = [];
    content.forEach(block => {
      if (!block) return;
      switch (block.type) {
       case "text":
        if (block.text) {
          contentArray.push({
            type: "text",
            text: block.text
          });
        }
        break;

       case "image":
        if (block.source && block.source.type === "base64") {
          contentArray.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`
            }
          });
        }
        break;

       case "tool_use":
        contentArray.push({
          type: "text",
          text: `[Tool use: ${block.name}]`
        });
        break;

       case "tool_result":
        contentArray.push({
          type: "text",
          text: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
        });
        break;

       default:
        if (block.text) {
          contentArray.push({
            type: "text",
            text: block.text
          });
        }
      }
    });
    return contentArray;
  }
  processClaudeResponseContent(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const contentArray = [];
    content.forEach(block => {
      if (!block) return;
      switch (block.type) {
       case "text":
        contentArray.push({
          type: "text",
          text: block.text || ""
        });
        break;

       case "image":
        if (block.source && block.source.type === "base64") {
          contentArray.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`
            }
          });
        }
        break;

       default:
        if (block.text) {
          contentArray.push({
            type: "text",
            text: block.text
          });
        }
      }
    });
    return contentArray.length === 1 && contentArray[0].type === "text" ? contentArray[0].text : contentArray;
  }
  static GEMINI_CLAUDE_THOUGHT_SIGNATURE="skip_thought_signature_validator";
  toGeminiRequest(claudeRequest) {
    if (!claudeRequest || typeof claudeRequest !== "object") {
      logger.warn("Invalid claudeRequest provided to toGeminiRequest.");
      return {
        contents: []
      };
    }
    const geminiRequest = {
      contents: []
    };
    if (claudeRequest.system) {
      if (Array.isArray(claudeRequest.system)) {
        const systemParts = [];
        claudeRequest.system.forEach(systemPrompt => {
          if (systemPrompt && systemPrompt.type === "text" && typeof systemPrompt.text === "string") {
            systemParts.push({
              text: systemPrompt.text
            });
          }
        });
        if (systemParts.length > 0) {
          geminiRequest.systemInstruction = {
            role: "user",
            parts: systemParts
          };
        }
      } else if (typeof claudeRequest.system === "string") {
        geminiRequest.systemInstruction = {
          parts: [ {
            text: claudeRequest.system
          } ]
        };
      } else if (typeof claudeRequest.system === "object") {
        geminiRequest.systemInstruction = {
          parts: [ {
            text: JSON.stringify(claudeRequest.system)
          } ]
        };
      }
    }
    if (Array.isArray(claudeRequest.messages)) {
      claudeRequest.messages.forEach(message => {
        if (!message || typeof message !== "object" || !message.role) {
          logger.warn("Skipping invalid message in claudeRequest.messages.");
          return;
        }
        const geminiRole = message.role === "assistant" ? "model" : "user";
        const content = message.content;
        if (Array.isArray(content)) {
          const parts = [];
          content.forEach(block => {
            if (!block || typeof block !== "object") return;
            switch (block.type) {
             case "text":
              if (typeof block.text === "string") {
                parts.push({
                  text: block.text
                });
              }
              break;

             case "thinking":
              if (typeof block.thinking === "string" && block.thinking.length > 0) {
                const thinkingPart = {
                  text: block.thinking,
                  thought: true
                };
                if (block.signature && block.signature.length >= 50) {
                  thinkingPart.thoughtSignature = block.signature;
                }
                parts.push(thinkingPart);
              }
              break;

             case "redacted_thinking":
              if (block.data) {
                parts.push({
                  text: `[Redacted Thinking: ${block.data}]`
                });
              }
              break;

             case "tool_use":
              if (block.name && block.input) {
                const args = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
                try {
                  const parsedArgs = JSON.parse(args);
                  if (parsedArgs && typeof parsedArgs === "object") {
                    parts.push({
                      thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                      functionCall: {
                        name: block.name,
                        args: parsedArgs
                      }
                    });
                  }
                } catch (e) {
                  if (block.input && typeof block.input === "object") {
                    parts.push({
                      thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                      functionCall: {
                        name: block.name,
                        args: block.input
                      }
                    });
                  }
                }
              }
              break;

             case "tool_result":
              const toolCallId = block.tool_use_id;
              if (toolCallId) {
                let funcName = toolCallId;
                if (toolCallId.startsWith("toolu_")) {
                  funcName = toolCallId;
                } else {
                  const toolCallIdParts = toolCallId.split("-");
                  if (toolCallIdParts.length > 1) {
                    funcName = toolCallIdParts.slice(0, -1).join("-");
                  }
                }
                let responseData = block.content;
                if (Array.isArray(responseData)) {
                  const textParts = responseData.filter(item => item && item.type === "text").map(item => item.text).join("\n");
                  responseData = textParts || JSON.stringify(responseData);
                } else if (typeof responseData !== "string") {
                  responseData = JSON.stringify(responseData);
                }
                parts.push({
                  functionResponse: {
                    name: funcName,
                    response: {
                      result: responseData
                    }
                  }
                });
              }
              break;

             case "image":
              if (block.source && block.source.type === "base64") {
                parts.push({
                  inlineData: {
                    mimeType: block.source.media_type,
                    data: block.source.data
                  }
                });
              }
              break;
            }
          });
          if (parts.length > 0) {
            geminiRequest.contents.push({
              role: geminiRole,
              parts: parts
            });
          }
        } else if (typeof content === "string") {
          geminiRequest.contents.push({
            role: geminiRole,
            parts: [ {
              text: content
            } ]
          });
        }
      });
    }
    const generationConfig = {};
    if (claudeRequest.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      generationConfig.temperature = claudeRequest.temperature;
    }
    if (claudeRequest.top_p !== undefined) {
      generationConfig.topP = claudeRequest.top_p;
    }
    if (claudeRequest.top_k !== undefined) {
      generationConfig.topK = claudeRequest.top_k;
    }
    if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
      if (claudeRequest.thinking.budget_tokens !== undefined) {
        const budget = claudeRequest.thinking.budget_tokens;
        if (!generationConfig.thinkingConfig) {
          generationConfig.thinkingConfig = {};
        }
        generationConfig.thinkingConfig.thinkingBudget = budget;
        generationConfig.thinkingConfig.include_thoughts = true;
      }
    }
    if (Object.keys(generationConfig).length > 0) {
      geminiRequest.generationConfig = generationConfig;
    }
    if (Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0) {
      const functionDeclarations = [];
      let googleSearchTool = null;
      let urlContextTool = null;
      let googleMapsTool = null;
      claudeRequest.tools.forEach(tool => {
        if (!tool || typeof tool !== "object") {
          logger.warn("Skipping invalid tool declaration in claudeRequest.tools.");
          return;
        }
        if (tool.google_search) {
          googleSearchTool = tool.google_search;
        }
        if (tool.url_context) {
          urlContextTool = tool.url_context;
        }
        if (tool.googleMaps) {
          googleMapsTool = tool.googleMaps;
        }
        if (!tool.name) {
          logger.warn("Skipping unnamed tool declaration in claudeRequest.tools.");
          return;
        }
        let inputSchema = tool.input_schema;
        if (inputSchema && typeof inputSchema === "object") {
          inputSchema = JSON.parse(JSON.stringify(inputSchema));
          delete inputSchema.$schema;
          this.cleanUrlFormatFromSchema(inputSchema);
        }
        const funcDecl = {
          name: String(tool.name),
          description: String(tool.description || "")
        };
        if (inputSchema) {
          funcDecl.parametersJsonSchema = inputSchema;
        }
        functionDeclarations.push(funcDecl);
      });
      if (functionDeclarations.length > 0 || googleSearchTool || urlContextTool || googleMapsTool) {
        geminiRequest.tools = [];
        if (functionDeclarations.length > 0) {
          geminiRequest.tools.push({
            functionDeclarations: functionDeclarations
          });
        }
        if (googleSearchTool) {
          geminiRequest.tools.push({
            googleSearch: googleSearchTool
          });
        }
        if (urlContextTool) {
          geminiRequest.tools.push({
            urlContext: urlContextTool
          });
        }
        if (googleMapsTool) {
          geminiRequest.tools.push({
            googleMaps: googleMapsTool
          });
        }
      }
    }
    if (claudeRequest.tool_choice) {
      geminiRequest.toolConfig = this.buildGeminiToolConfigFromClaude(claudeRequest.tool_choice);
    }
    geminiRequest.safetySettings = this.getDefaultSafetySettings();
    return geminiRequest;
  }
  cleanUrlFormatFromSchema(schema) {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "string" && schema.format === "uri") {
      delete schema.format;
    }
    if (schema.properties && typeof schema.properties === "object") {
      Object.values(schema.properties).forEach(prop => {
        this.cleanUrlFormatFromSchema(prop);
      });
    }
    if (schema.items) {
      this.cleanUrlFormatFromSchema(schema.items);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      this.cleanUrlFormatFromSchema(schema.additionalProperties);
    }
  }
  getDefaultSafetySettings() {
    return [ {
      category: "HARM_CATEGORY_HARASSMENT",
      threshold: "OFF"
    }, {
      category: "HARM_CATEGORY_HATE_SPEECH",
      threshold: "OFF"
    }, {
      category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      threshold: "OFF"
    }, {
      category: "HARM_CATEGORY_DANGEROUS_CONTENT",
      threshold: "OFF"
    }, {
      category: "HARM_CATEGORY_CIVIC_INTEGRITY",
      threshold: "OFF"
    } ];
  }
  toGeminiResponse(claudeResponse, model) {
    if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
      return {
        candidates: [],
        usageMetadata: {}
      };
    }
    const parts = [];
    for (const block of claudeResponse.content) {
      if (!block) continue;
      switch (block.type) {
       case "text":
        if (block.text) {
          parts.push({
            text: block.text
          });
        }
        break;

       case "thinking":
        if (block.thinking) {
          const thinkingPart = {
            text: block.thinking,
            thought: true
          };
          if (block.signature && block.signature.length >= 50) {
            thinkingPart.thoughtSignature = block.signature;
          }
          parts.push(thinkingPart);
        }
        break;

       case "tool_use":
        const functionCallPart = {
          functionCall: {
            name: block.name,
            args: block.input || {}
          }
        };
        if (block.id) {
          functionCallPart.functionCall.id = block.id;
        }
        if (block.signature && block.signature.length >= 50) {
          functionCallPart.thoughtSignature = block.signature;
        }
        parts.push(functionCallPart);
        break;

       case "image":
        if (block.source && block.source.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data
            }
          });
        }
        break;

       default:
        if (block.text) {
          parts.push({
            text: block.text
          });
        }
      }
    }
    const finishReasonMap = {
      end_turn: "STOP",
      max_tokens: "MAX_TOKENS",
      tool_use: "STOP",
      stop_sequence: "STOP"
    };
    return {
      candidates: [ {
        content: {
          role: "model",
          parts: parts
        },
        finishReason: finishReasonMap[claudeResponse.stop_reason] || "STOP"
      } ],
      usageMetadata: claudeResponse.usage ? {
        promptTokenCount: claudeResponse.usage.input_tokens || 0,
        candidatesTokenCount: claudeResponse.usage.output_tokens || 0,
        totalTokenCount: (claudeResponse.usage.input_tokens || 0) + (claudeResponse.usage.output_tokens || 0),
        cachedContentTokenCount: claudeResponse.usage.cache_read_input_tokens || 0,
        promptTokensDetails: [ {
          modality: "TEXT",
          tokenCount: claudeResponse.usage.input_tokens || 0
        } ],
        candidatesTokensDetails: [ {
          modality: "TEXT",
          tokenCount: claudeResponse.usage.output_tokens || 0
        } ]
      } : {}
    };
  }
  toGeminiStreamChunk(claudeChunk, model) {
    if (!claudeChunk) return null;
    if (typeof claudeChunk === "object" && !Array.isArray(claudeChunk)) {
      if (claudeChunk.type === "content_block_start") {
        const contentBlock = claudeChunk.content_block;
        if (contentBlock && contentBlock.type === "thinking") {
          return null;
        }
        if (contentBlock && contentBlock.type === "tool_use") {
          return {
            candidates: [ {
              content: {
                role: "model",
                parts: [ {
                  functionCall: {
                    name: contentBlock.name,
                    args: {},
                    id: contentBlock.id
                  }
                } ]
              }
            } ]
          };
        }
      }
      if (claudeChunk.type === "content_block_delta") {
        const delta = claudeChunk.delta;
        if (delta && delta.type === "text_delta") {
          return {
            candidates: [ {
              content: {
                role: "model",
                parts: [ {
                  text: delta.text || ""
                } ]
              }
            } ]
          };
        }
        if (delta && delta.type === "thinking_delta") {
          return {
            candidates: [ {
              content: {
                role: "model",
                parts: [ {
                  text: delta.thinking || "",
                  thought: true
                } ]
              }
            } ]
          };
        }
        if (delta && delta.type === "signature_delta") {
          return null;
        }
        if (delta && delta.type === "input_json_delta") {
          return null;
        }
      }
      if (claudeChunk.type === "message_delta") {
        const stopReason = claudeChunk.delta?.stop_reason;
        const result = {
          candidates: [ {
            finishReason: stopReason === "end_turn" ? "STOP" : stopReason === "max_tokens" ? "MAX_TOKENS" : stopReason === "tool_use" ? "STOP" : "OTHER"
          } ]
        };
        if (claudeChunk.usage) {
          result.usageMetadata = {
            promptTokenCount: claudeChunk.usage.input_tokens || 0,
            candidatesTokenCount: claudeChunk.usage.output_tokens || 0,
            totalTokenCount: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
            cachedContentTokenCount: claudeChunk.usage.cache_read_input_tokens || 0,
            promptTokensDetails: [ {
              modality: "TEXT",
              tokenCount: claudeChunk.usage.input_tokens || 0
            } ],
            candidatesTokensDetails: [ {
              modality: "TEXT",
              tokenCount: claudeChunk.usage.output_tokens || 0
            } ]
          };
        }
        return result;
      }
    }
    if (typeof claudeChunk === "string") {
      return {
        candidates: [ {
          content: {
            role: "model",
            parts: [ {
              text: claudeChunk
            } ]
          }
        } ]
      };
    }
    return null;
  }
  processClaudeContentToGeminiParts(content) {
    if (!content) return [];
    if (typeof content === "string") {
      return [ {
        text: content
      } ];
    }
    if (Array.isArray(content)) {
      const parts = [];
      content.forEach(block => {
        if (!block || typeof block !== "object" || !block.type) {
          logger.warn("Skipping invalid content block.");
          return;
        }
        switch (block.type) {
         case "text":
          if (typeof block.text === "string") {
            parts.push({
              text: block.text
            });
          }
          break;

         case "image":
          if (block.source && typeof block.source === "object" && block.source.type === "base64" && typeof block.source.media_type === "string" && typeof block.source.data === "string") {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data
              }
            });
          }
          break;

         case "tool_use":
          if (typeof block.name === "string" && block.input && typeof block.input === "object") {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input
              }
            });
          }
          break;

         case "tool_result":
          if (typeof block.tool_use_id === "string") {
            parts.push({
              functionResponse: {
                name: block.tool_use_id,
                response: {
                  content: block.content
                }
              }
            });
          }
          break;

         default:
          if (typeof block.text === "string") {
            parts.push({
              text: block.text
            });
          }
        }
      });
      return parts;
    }
    return [];
  }
  buildGeminiToolConfigFromClaude(claudeToolChoice) {
    if (!claudeToolChoice || typeof claudeToolChoice !== "object" || !claudeToolChoice.type) {
      logger.warn("Invalid claudeToolChoice provided.");
      return undefined;
    }
    switch (claudeToolChoice.type) {
     case "auto":
      return {
        functionCallingConfig: {
          mode: "AUTO"
        }
      };

     case "none":
      return {
        functionCallingConfig: {
          mode: "NONE"
        }
      };

     case "tool":
      if (claudeToolChoice.name && typeof claudeToolChoice.name === "string") {
        return {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [ claudeToolChoice.name ]
          }
        };
      }
      logger.warn("Invalid tool name in claudeToolChoice of type 'tool'.");
      return undefined;

     default:
      logger.warn(`Unsupported claudeToolChoice type: ${claudeToolChoice.type}`);
      return undefined;
    }
  }
  toOpenAIResponsesRequest(claudeRequest) {
    const responsesRequest = {
      model: claudeRequest.model,
      instructions: "",
      input: [],
      stream: claudeRequest.stream || false,
      max_output_tokens: claudeRequest.max_tokens,
      temperature: claudeRequest.temperature,
      top_p: claudeRequest.top_p
    };
    if (claudeRequest.system) {
      if (Array.isArray(claudeRequest.system)) {
        responsesRequest.instructions = claudeRequest.system.map(s => typeof s === "string" ? s : s.text).join("\n");
      } else {
        responsesRequest.instructions = claudeRequest.system;
      }
    }
    if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
      responsesRequest.reasoning = {
        effort: determineReasoningEffortFromBudget(claudeRequest.thinking.budget_tokens)
      };
    }
    if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
      claudeRequest.messages.forEach(msg => {
        const role = msg.role;
        const content = msg.content;
        if (Array.isArray(content)) {
          const toolResult = content.find(c => c.type === "tool_result");
          if (toolResult) {
            responsesRequest.input.push({
              type: "function_call_output",
              call_id: toolResult.tool_use_id,
              output: typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content)
            });
            return;
          }
          const toolUse = content.find(c => c.type === "tool_use");
          if (toolUse) {
            responsesRequest.input.push({
              type: "function_call",
              call_id: toolUse.id,
              name: toolUse.name,
              arguments: typeof toolUse.input === "string" ? toolUse.input : JSON.stringify(toolUse.input)
            });
            return;
          }
          const responsesContent = content.map(c => {
            if (c.type === "text") {
              return {
                type: role === "assistant" ? "output_text" : "input_text",
                text: c.text
              };
            } else if (c.type === "image") {
              return {
                type: "input_image",
                image_url: {
                  url: `data:${c.source.media_type};base64,${c.source.data}`
                }
              };
            }
            return null;
          }).filter(Boolean);
          if (responsesContent.length > 0) {
            responsesRequest.input.push({
              type: "message",
              role: role,
              content: responsesContent
            });
          }
        } else if (typeof content === "string") {
          responsesRequest.input.push({
            type: "message",
            role: role,
            content: [ {
              type: role === "assistant" ? "output_text" : "input_text",
              text: content
            } ]
          });
        }
      });
    }
    if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
      responsesRequest.tools = claudeRequest.tools.map(tool => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {
          type: "object",
          properties: {}
        }
      }));
    }
    if (claudeRequest.tool_choice) {
      if (claudeRequest.tool_choice.type === "auto") {
        responsesRequest.tool_choice = "auto";
      } else if (claudeRequest.tool_choice.type === "any") {
        responsesRequest.tool_choice = "required";
      } else if (claudeRequest.tool_choice.type === "tool") {
        responsesRequest.tool_choice = {
          type: "function",
          function: {
            name: claudeRequest.tool_choice.name
          }
        };
      }
    }
    return responsesRequest;
  }
  toOpenAIResponsesResponse(claudeResponse, model) {
    const content = this.processClaudeResponseContent(claudeResponse.content);
    const textContent = typeof content === "string" ? content : JSON.stringify(content);
    let output = [];
    output.push({
      type: "message",
      id: `msg_${uuidv4().replace(/-/g, "")}`,
      summary: [],
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
      model: model || claudeResponse.model,
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
        input_tokens: claudeResponse.usage?.input_tokens || 0,
        input_tokens_details: {
          cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
        },
        output_tokens: claudeResponse.usage?.output_tokens || 0,
        output_tokens_details: {
          reasoning_tokens: 0
        },
        total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
      },
      user: null
    };
  }
  toOpenAIResponsesStreamChunk(claudeChunk, model, requestId = null) {
    if (!claudeChunk) return [];
    const responseId = requestId || `resp_${uuidv4().replace(/-/g, "")}`;
    const events = [];
    if (claudeChunk.type === "message_start") {
      events.push(generateResponseCreated(responseId, model || "unknown"), generateResponseInProgress(responseId), generateOutputItemAdded(responseId), generateContentPartAdded(responseId));
    }
    if (claudeChunk.type === "content_block_start") {
      const contentBlock = claudeChunk.content_block;
      if (contentBlock && contentBlock.type === "tool_use") {
        startToolCall(responseId, contentBlock.id, contentBlock.name);
        events.push({
          item: {
            id: contentBlock.id,
            call_id: contentBlock.id,
            type: "function_call",
            name: contentBlock.name,
            arguments: "",
            status: "in_progress"
          },
          output_index: claudeChunk.index || 0,
          sequence_number: 2,
          type: "response.output_item.added"
        });
      }
    }
    if (claudeChunk.type === "content_block_delta") {
      const delta = claudeChunk.delta;
      if (delta && delta.type === "text_delta") {
        events.push(generateOutputTextDelta(responseId, delta.text || ""));
      } else if (delta && delta.type === "thinking_delta") {
        events.push({
          delta: delta.thinking || "",
          item_id: `thinking_${uuidv4().replace(/-/g, "")}`,
          output_index: claudeChunk.index || 0,
          sequence_number: 3,
          type: "response.reasoning_summary_text.delta"
        });
      } else if (delta && delta.type === "input_json_delta") {
        const state = streamStateManager.getOrCreateState(responseId);
        const itemId = state.currentToolCall ? state.currentToolCall.id : "unknown";
        events.push(generateFunctionCallArgsDelta(responseId, itemId, claudeChunk.index || 0, delta.partial_json || ""));
      }
    }
    if (claudeChunk.type === "content_block_stop") {
      const state = streamStateManager.getOrCreateState(responseId);
      if (state.currentToolCall) {
        const itemId = state.currentToolCall.id;
        const outputIdx = claudeChunk.index || 0;
        events.push(generateFunctionCallArgsDone(responseId, itemId, outputIdx));
        const finished = finishToolCall(responseId);
        if (finished) {
          events.push(generateFunctionCallOutputItemDone(responseId, finished, outputIdx));
        }
      }
    }
    if (claudeChunk.type === "message_delta") {
      if (claudeChunk.usage) {
        const state = streamStateManager.getOrCreateState(responseId);
        state.savedUsage = {
          input_tokens: claudeChunk.usage.input_tokens || 0,
          input_tokens_details: {
            cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
          },
          output_tokens: claudeChunk.usage.output_tokens || 0,
          output_tokens_details: {
            reasoning_tokens: 0
          },
          total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0)
        };
      }
    }
    if (claudeChunk.type === "message_stop") {
      const state = streamStateManager.getOrCreateState(responseId);
      const savedUsage = state.savedUsage || null;
      events.push(generateOutputTextDone(responseId), generateContentPartDone(responseId), generateOutputItemDone(responseId), generateResponseCompleted(responseId, savedUsage));
    }
    return events;
  }
  _shortenNameIfNeeded(name) {
    const limit = 64;
    if (name.length <= limit) {
      return name;
    }
    if (name.startsWith("mcp__")) {
      const idx = name.lastIndexOf("__");
      if (idx > 0) {
        const cand = "mcp__" + name.substring(idx + 2);
        if (cand.length > limit) {
          return cand.substring(0, limit);
        }
        return cand;
      }
    }
    return name.substring(0, limit);
  }
  _buildShortNameMap(names) {
    const limit = 64;
    const used = new Set;
    const m = {};
    const baseCandidate = n => {
      if (n.length <= limit) {
        return n;
      }
      if (n.startsWith("mcp__")) {
        const idx = n.lastIndexOf("__");
        if (idx > 0) {
          let cand = "mcp__" + n.substring(idx + 2);
          if (cand.length > limit) {
            cand = cand.substring(0, limit);
          }
          return cand;
        }
      }
      return n.substring(0, limit);
    };
    const makeUnique = cand => {
      if (!used.has(cand)) {
        return cand;
      }
      const base = cand;
      for (let i = 1; ;i++) {
        const suffix = "_" + i;
        const allowed = limit - suffix.length;
        let tmp = base;
        if (tmp.length > (allowed < 0 ? 0 : allowed)) {
          tmp = tmp.substring(0, allowed < 0 ? 0 : allowed);
        }
        tmp = tmp + suffix;
        if (!used.has(tmp)) {
          return tmp;
        }
      }
    };
    for (const n of names) {
      const cand = baseCandidate(n);
      const uniq = makeUnique(cand);
      used.add(uniq);
      m[n] = uniq;
    }
    return m;
  }
  _normalizeToolParameters(schema) {
    if (!schema || typeof schema !== "object") {
      return {
        type: "object",
        properties: {}
      };
    }
    const result = {
      ...schema
    };
    if (!result.type) {
      result.type = "object";
    }
    if (result.type === "object" && !result.properties) {
      result.properties = {};
    }
    return result;
  }
  toCodexRequest(claudeRequest) {
    const codexRequest = {
      model: claudeRequest.model,
      instructions: "",
      input: [],
      stream: true,
      store: false,
      parallel_tool_calls: true,
      metadata: claudeRequest.metadata || {},
      reasoning: {
        effort: claudeRequest.reasoning?.effort || "medium",
        summary: "auto"
      },
      include: [ "reasoning.encrypted_content" ]
    };
    if (claudeRequest.system) {
      let instructions = "";
      if (Array.isArray(claudeRequest.system)) {
        instructions = claudeRequest.system.map(s => typeof s === "string" ? s : s.text).join("\n");
      } else {
        instructions = claudeRequest.system;
      }
      codexRequest.instructions = instructions;
      const systemParts = Array.isArray(claudeRequest.system) ? claudeRequest.system : [ {
        type: "text",
        text: claudeRequest.system
      } ];
      const developerMessage = {
        type: "message",
        role: "developer",
        content: []
      };
      systemParts.forEach(part => {
        if (part.type === "text") {
          developerMessage.content.push({
            type: "input_text",
            text: part.text
          });
        } else if (typeof part === "string") {
          developerMessage.content.push({
            type: "input_text",
            text: part
          });
        }
      });
      if (developerMessage.content.length > 0) {
        codexRequest.input.push(developerMessage);
      }
    }
    let shortMap = {};
    if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
      const toolNames = claudeRequest.tools.map(t => t.name).filter(Boolean);
      shortMap = this._buildShortNameMap(toolNames);
      codexRequest.tools = claudeRequest.tools.map(tool => {
        if (tool.type === "web_search_20250305") {
          return {
            type: "web_search"
          };
        }
        let name = tool.name;
        if (shortMap[name]) {
          name = shortMap[name];
        } else {
          name = this._shortenNameIfNeeded(name);
        }
        const convertedTool = {
          type: "function",
          name: name,
          description: tool.description || "",
          parameters: this._normalizeToolParameters(tool.input_schema),
          strict: false
        };
        if (convertedTool.parameters && convertedTool.parameters.$schema) {
          delete convertedTool.parameters.$schema;
        }
        return convertedTool;
      });
      codexRequest.tool_choice = "auto";
    }
    if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
      for (const msg of claudeRequest.messages) {
        const role = msg.role;
        const content = msg.content;
        let currentMessage = {
          type: "message",
          role: role,
          content: []
        };
        const flushMessage = () => {
          if (currentMessage.content.length > 0) {
            codexRequest.input.push({
              ...currentMessage
            });
            currentMessage.content = [];
          }
        };
        const appendTextContent = text => {
          const partType = role === "assistant" ? "output_text" : "input_text";
          currentMessage.content.push({
            type: partType,
            text: text
          });
        };
        const appendImageContent = (data, mediaType) => {
          currentMessage.content.push({
            type: "input_image",
            image_url: `data:${mediaType};base64,${data}`
          });
        };
        if (Array.isArray(content)) {
          for (const block of content) {
            switch (block.type) {
             case "text":
              appendTextContent(block.text);
              break;

             case "image":
              if (block.source) {
                const data = block.source.data || block.source.base64 || "";
                const mediaType = block.source.media_type || block.source.mime_type || "application/octet-stream";
                if (data) {
                  appendImageContent(data, mediaType);
                }
              }
              break;

             case "tool_use":
              flushMessage();
              let toolName = block.name;
              if (shortMap[toolName]) {
                toolName = shortMap[toolName];
              } else {
                toolName = this._shortenNameIfNeeded(toolName);
              }
              codexRequest.input.push({
                type: "function_call",
                call_id: block.id,
                name: toolName,
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
              });
              break;

             case "tool_result":
              flushMessage();
              codexRequest.input.push({
                type: "function_call_output",
                call_id: block.tool_use_id,
                output: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")
              });
              break;
            }
          }
        } else if (typeof content === "string") {
          appendTextContent(content);
        }
        flushMessage();
      }
    }
    if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
      const budgetTokens = claudeRequest.thinking.budget_tokens;
      codexRequest.reasoning.effort = determineReasoningEffortFromBudget(budgetTokens);
    } else if (claudeRequest.thinking && claudeRequest.thinking.type === "disabled") {
      codexRequest.reasoning.effort = determineReasoningEffortFromBudget(0);
    }
    const shouldInjectInstructions = process.env.CODEX_INSTRUCTIONS_ENABLED === "true";
    if (shouldInjectInstructions && codexRequest.input.length > 0) {
      const firstInput = codexRequest.input[0];
      const firstText = firstInput.content && firstInput.content[0] && firstInput.content[0].text;
      const instructions = "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!";
      if (firstText !== instructions) {
        codexRequest.input.unshift({
          type: "message",
          role: "user",
          content: [ {
            type: "input_text",
            text: instructions
          } ]
        });
      }
    }
    return codexRequest;
  }
  toGrokRequest(claudeRequest) {
    const openaiRequest = this.toOpenAIRequest(claudeRequest);
    return {
      ...openaiRequest,
      _isConverted: true
    };
  }
  toCodexResponse(codexResponse, model) {
    const content = [];
    let stopReason = "end_turn";
    if (codexResponse.response?.output) {
      codexResponse.response.output.forEach(item => {
        if (item.type === "message" && item.content) {
          const textPart = item.content.find(c => c.type === "output_text");
          if (textPart) content.push({
            type: "text",
            text: textPart.text
          });
        } else if (item.type === "reasoning" && item.summary) {
          const textPart = item.summary.find(c => c.type === "summary_text");
          if (textPart) content.push({
            type: "thinking",
            thinking: textPart.text
          });
        } else if (item.type === "function_call") {
          stopReason = "tool_use";
          content.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments
          });
        }
      });
    }
    return {
      id: codexResponse.response?.id || `msg_${uuidv4().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: model,
      content: content,
      stop_reason: stopReason,
      usage: {
        input_tokens: codexResponse.response?.usage?.input_tokens || 0,
        output_tokens: codexResponse.response?.usage?.output_tokens || 0
      }
    };
  }
  toCodexStreamChunk(codexChunk, model) {
    const type = codexChunk.type;
    const resId = codexChunk.response?.id || "default";
    if (type === "response.created") {
      return {
        type: "message_start",
        message: {
          id: codexChunk.response.id,
          type: "message",
          role: "assistant",
          content: [],
          model: model,
          usage: {
            input_tokens: 0,
            output_tokens: 0
          }
        }
      };
    }
    if (type === "response.reasoning_summary_text.delta") {
      return {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: codexChunk.delta
        }
      };
    }
    if (type === "response.output_text.delta") {
      return {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: codexChunk.delta
        }
      };
    }
    if (type === "response.output_item.done" && codexChunk.item?.type === "function_call") {
      return [ {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: codexChunk.item.call_id,
          name: codexChunk.item.name,
          input: {}
        }
      }, {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: typeof codexChunk.item.arguments === "string" ? codexChunk.item.arguments : JSON.stringify(codexChunk.item.arguments)
        }
      }, {
        type: "content_block_stop",
        index: 0
      } ];
    }
    if (type === "response.completed") {
      return [ {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn"
        },
        usage: {
          input_tokens: codexChunk.response.usage?.input_tokens || 0,
          output_tokens: codexChunk.response.usage?.output_tokens || 0
        }
      }, {
        type: "message_stop"
      } ];
    }
    return null;
  }
}

export default ClaudeConverter;