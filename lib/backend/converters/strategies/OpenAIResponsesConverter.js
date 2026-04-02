import { v4 as uuidv4 } from "uuid";

import { BaseConverter } from "../BaseConverter.js";

import { CodexConverter } from "./CodexConverter.js";

import { MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

import { extractAndProcessSystemMessages as extractSystemMessages, extractTextFromMessageContent as extractText, CLAUDE_DEFAULT_MAX_TOKENS, GEMINI_DEFAULT_INPUT_TOKEN_LIMIT, GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT } from "../utils.js";

import { generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted } from "../../providers/openai/openai-responses-core.mjs";

export class OpenAIResponsesConverter extends BaseConverter {
  constructor() {
    super(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    this.codexConverter = new CodexConverter;
  }
  convertRequest(data, toProtocol) {
    switch (toProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIRequest(data);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeRequest(data);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiRequest(data);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexRequest(data);

     case MODEL_PROTOCOL_PREFIX.GROK:
      return this.toGrokRequest(data);

     default:
      throw new Error(`Unsupported target protocol: ${toProtocol}`);
    }
  }
  convertResponse(data, toProtocol, model) {
    switch (toProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexResponse(data, model);

     default:
      throw new Error(`Unsupported target protocol: ${toProtocol}`);
    }
  }
  convertStreamChunk(chunk, toProtocol, model) {
    switch (toProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.CODEX:
      return this.toCodexStreamChunk(chunk, model);

     default:
      throw new Error(`Unsupported target protocol: ${toProtocol}`);
    }
  }
  convertModelList(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.OPENAI:
      return this.toOpenAIModelList(data);

     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeModelList(data);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiModelList(data);

     default:
      return data;
    }
  }
  toOpenAIRequest(responsesRequest) {
    const openaiRequest = {
      model: responsesRequest.model,
      messages: [],
      stream: responsesRequest.stream || false
    };
    if (responsesRequest.temperature !== undefined) {
      openaiRequest.temperature = responsesRequest.temperature;
    }
    if (responsesRequest.max_output_tokens !== undefined) {
      openaiRequest.max_tokens = responsesRequest.max_output_tokens;
    } else if (responsesRequest.max_tokens !== undefined) {
      openaiRequest.max_tokens = responsesRequest.max_tokens;
    }
    if (responsesRequest.top_p !== undefined) {
      openaiRequest.top_p = responsesRequest.top_p;
    }
    if (responsesRequest.parallel_tool_calls !== undefined) {
      openaiRequest.parallel_tool_calls = responsesRequest.parallel_tool_calls;
    }
    if (responsesRequest.instructions) {
      openaiRequest.messages.push({
        role: "system",
        content: responsesRequest.instructions
      });
    }
    if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
      responsesRequest.input.forEach(item => {
        const itemType = item.type || (item.role ? "message" : "");
        switch (itemType) {
         case "message":
          let content = "";
          if (Array.isArray(item.content)) {
            content = item.content.filter(c => c.type === "input_text" || c.type === "output_text").map(c => c.text).join("\n");
          } else if (typeof item.content === "string") {
            content = item.content;
          }
          if (content || (item.role === "assistant" || item.role === "developer")) {
            openaiRequest.messages.push({
              role: item.role === "developer" ? "assistant" : item.role,
              content: content
            });
          }
          break;

         case "function_call":
          openaiRequest.messages.push({
            role: "assistant",
            tool_calls: [ {
              id: item.call_id,
              type: "function",
              function: {
                name: item.name,
                arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments)
              }
            } ]
          });
          break;

         case "function_call_output":
          openaiRequest.messages.push({
            role: "tool",
            tool_call_id: item.call_id,
            content: item.output
          });
          break;
        }
      });
    }
    if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
      responsesRequest.messages.forEach(msg => {
        openaiRequest.messages.push({
          role: msg.role,
          content: msg.content
        });
      });
    }
    if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
      openaiRequest.tools = responsesRequest.tools.map(tool => {
        if (tool.type && tool.type !== "function") {
          return null;
        }
        const name = tool.name || tool.function && tool.function.name;
        const description = tool.description || tool.function && tool.function.description;
        const parameters = tool.parameters || tool.function && tool.function.parameters || tool.parametersJsonSchema || {
          type: "object",
          properties: {}
        };
        if (!name) {
          return null;
        }
        return {
          type: "function",
          function: {
            name: name,
            description: description,
            parameters: parameters
          }
        };
      }).filter(tool => tool !== null);
    }
    if (responsesRequest.tool_choice) {
      openaiRequest.tool_choice = responsesRequest.tool_choice;
    }
    return openaiRequest;
  }
  toOpenAIResponse(responsesResponse, model) {
    const choices = [];
    let usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: {
        cached_tokens: 0
      },
      completion_tokens_details: {
        reasoning_tokens: 0
      }
    };
    if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
      responsesResponse.output.forEach((item, index) => {
        if (item.type === "message") {
          const content = item.content?.filter(c => c.type === "output_text").map(c => c.text).join("") || "";
          choices.push({
            index: index,
            message: {
              role: "assistant",
              content: content
            },
            finish_reason: responsesResponse.status === "completed" ? "stop" : null
          });
        } else if (item.type === "function_call") {
          choices.push({
            index: index,
            message: {
              role: "assistant",
              tool_calls: [ {
                id: item.call_id,
                type: "function",
                function: {
                  name: item.name,
                  arguments: item.arguments
                }
              } ]
            },
            finish_reason: "tool_calls"
          });
        }
      });
    }
    if (responsesResponse.usage) {
      usage = {
        prompt_tokens: responsesResponse.usage.input_tokens || 0,
        completion_tokens: responsesResponse.usage.output_tokens || 0,
        total_tokens: responsesResponse.usage.total_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: responsesResponse.usage.input_tokens_details?.cached_tokens || 0
        },
        completion_tokens_details: {
          reasoning_tokens: responsesResponse.usage.output_tokens_details?.reasoning_tokens || 0
        }
      };
    }
    return {
      id: responsesResponse.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: responsesResponse.created_at || Math.floor(Date.now() / 1e3),
      model: model || responsesResponse.model,
      choices: choices.length > 0 ? choices : [ {
        index: 0,
        message: {
          role: "assistant",
          content: ""
        },
        finish_reason: "stop"
      } ],
      usage: usage
    };
  }
  toOpenAIStreamChunk(responsesChunk, model) {
    const resId = responsesChunk.response?.id || responsesChunk.id || `chatcmpl-${Date.now()}`;
    const created = responsesChunk.response?.created_at || responsesChunk.created || Math.floor(Date.now() / 1e3);
    const delta = {};
    let finish_reason = null;
    if (responsesChunk.type === "response.output_text.delta") {
      delta.content = responsesChunk.delta;
    } else if (responsesChunk.type === "response.function_call_arguments.delta") {
      delta.tool_calls = [ {
        index: responsesChunk.output_index || 0,
        function: {
          arguments: responsesChunk.delta
        }
      } ];
    } else if (responsesChunk.type === "response.output_item.added" && responsesChunk.item?.type === "function_call") {
      delta.tool_calls = [ {
        index: responsesChunk.output_index || 0,
        id: responsesChunk.item.call_id,
        type: "function",
        function: {
          name: responsesChunk.item.name,
          arguments: ""
        }
      } ];
    } else if (responsesChunk.type === "response.completed") {
      finish_reason = "stop";
    }
    return {
      id: resId,
      object: "chat.completion.chunk",
      created: created,
      model: model || responsesChunk.response?.model || responsesChunk.model,
      choices: [ {
        index: 0,
        delta: delta,
        finish_reason: finish_reason
      } ]
    };
  }
  toClaudeRequest(responsesRequest) {
    const claudeRequest = {
      model: responsesRequest.model,
      messages: [],
      max_tokens: responsesRequest.max_output_tokens || responsesRequest.max_tokens || CLAUDE_DEFAULT_MAX_TOKENS,
      stream: responsesRequest.stream || false
    };
    if (responsesRequest.instructions) {
      claudeRequest.system = responsesRequest.instructions;
    }
    if (responsesRequest.reasoning?.effort) {
      const effort = String(responsesRequest.reasoning.effort || "").toLowerCase().trim();
      let budgetTokens = 2e4;
      if (effort === "low") budgetTokens = 2048; else if (effort === "medium") budgetTokens = 8192; else if (effort === "high") budgetTokens = 2e4;
      claudeRequest.thinking = {
        type: "enabled",
        budget_tokens: budgetTokens
      };
    }
    if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
      responsesRequest.input.forEach(item => {
        const itemType = item.type || (item.role ? "message" : "");
        switch (itemType) {
         case "message":
          const content = [];
          if (Array.isArray(item.content)) {
            item.content.forEach(c => {
              if (c.type === "input_text" || c.type === "output_text") {
                content.push({
                  type: "text",
                  text: c.text
                });
              } else if (c.type === "input_image") {
                const url = c.image_url?.url || c.url;
                if (url && url.startsWith("data:")) {
                  const [mediaInfo, data] = url.split(";base64,");
                  const mediaType = mediaInfo.replace("data:", "");
                  content.push({
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mediaType,
                      data: data
                    }
                  });
                }
              }
            });
          } else if (typeof item.content === "string") {
            content.push({
              type: "text",
              text: item.content
            });
          }
          if (content.length > 0) {
            claudeRequest.messages.push({
              role: item.role === "assistant" ? "assistant" : "user",
              content: content.length === 1 && content[0].type === "text" ? content[0].text : content
            });
          }
          break;

         case "function_call":
          claudeRequest.messages.push({
            role: "assistant",
            content: [ {
              type: "tool_use",
              id: item.call_id || `toolu_${uuidv4().replace(/-/g, "")}`,
              name: item.name,
              input: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments
            } ]
          });
          break;

         case "function_call_output":
          claudeRequest.messages.push({
            role: "user",
            content: [ {
              type: "tool_result",
              tool_use_id: item.call_id,
              content: item.output
            } ]
          });
          break;
        }
      });
    }
    if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
      claudeRequest.tools = responsesRequest.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters || tool.parametersJsonSchema || {
          type: "object",
          properties: {}
        }
      }));
    }
    if (responsesRequest.tool_choice) {
      if (typeof responsesRequest.tool_choice === "string") {
        if (responsesRequest.tool_choice === "auto") {
          claudeRequest.tool_choice = {
            type: "auto"
          };
        } else if (responsesRequest.tool_choice === "required") {
          claudeRequest.tool_choice = {
            type: "any"
          };
        }
      } else if (responsesRequest.tool_choice.type === "function") {
        claudeRequest.tool_choice = {
          type: "tool",
          name: responsesRequest.tool_choice.function.name
        };
      }
    }
    return claudeRequest;
  }
  toClaudeResponse(responsesResponse, model) {
    const content = [];
    let stop_reason = "end_turn";
    if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
      responsesResponse.output.forEach(item => {
        if (item.type === "message") {
          const text = item.content?.filter(c => c.type === "output_text").map(c => c.text).join("") || "";
          if (text) {
            content.push({
              type: "text",
              text: text
            });
          }
        } else if (item.type === "function_call") {
          content.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments
          });
          stop_reason = "tool_use";
        }
      });
    }
    return {
      id: responsesResponse.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: content,
      model: model || responsesResponse.model,
      stop_reason: stop_reason,
      usage: {
        input_tokens: responsesResponse.usage?.input_tokens || 0,
        output_tokens: responsesResponse.usage?.output_tokens || 0,
        total_tokens: responsesResponse.usage?.total_tokens || 0
      }
    };
  }
  toClaudeStreamChunk(responsesChunk, model) {
    if (responsesChunk.type === "response.created") {
      return {
        type: "message_start",
        message: {
          id: responsesChunk.response.id,
          type: "message",
          role: "assistant",
          content: [],
          model: model || responsesChunk.response.model
        }
      };
    }
    if (responsesChunk.type === "response.output_text.delta") {
      return {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: responsesChunk.delta
        }
      };
    }
    if (responsesChunk.type === "response.function_call_arguments.delta") {
      return {
        type: "content_block_delta",
        index: responsesChunk.output_index || 0,
        delta: {
          type: "input_json_delta",
          partial_json: responsesChunk.delta
        }
      };
    }
    if (responsesChunk.type === "response.output_item.added" && responsesChunk.item?.type === "function_call") {
      return {
        type: "content_block_start",
        index: responsesChunk.output_index || 0,
        content_block: {
          type: "tool_use",
          id: responsesChunk.item.call_id,
          name: responsesChunk.item.name,
          input: {}
        }
      };
    }
    if (responsesChunk.type === "response.completed") {
      return {
        type: "message_stop"
      };
    }
    return null;
  }
  toGeminiRequest(responsesRequest) {
    const geminiRequest = {
      contents: [],
      generationConfig: {}
    };
    if (responsesRequest.instructions) {
      geminiRequest.systemInstruction = {
        parts: [ {
          text: responsesRequest.instructions
        } ]
      };
    }
    if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
      responsesRequest.input.forEach(item => {
        const itemType = item.type || (item.role ? "message" : "");
        switch (itemType) {
         case "message":
          const parts = [];
          if (Array.isArray(item.content)) {
            item.content.forEach(c => {
              if (c.type === "input_text" || c.type === "output_text") {
                parts.push({
                  text: c.text
                });
              } else if (c.type === "input_image") {
                const url = c.image_url?.url || c.url;
                if (url && url.startsWith("data:")) {
                  const [mediaInfo, data] = url.split(";base64,");
                  const mimeType = mediaInfo.replace("data:", "");
                  parts.push({
                    inlineData: {
                      mimeType: mimeType,
                      data: data
                    }
                  });
                }
              }
            });
          } else if (typeof item.content === "string") {
            parts.push({
              text: item.content
            });
          }
          if (parts.length > 0) {
            geminiRequest.contents.push({
              role: item.role === "assistant" ? "model" : "user",
              parts: parts
            });
          }
          break;

         case "function_call":
          geminiRequest.contents.push({
            role: "model",
            parts: [ {
              functionCall: {
                name: item.name,
                args: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments
              }
            } ]
          });
          break;

         case "function_call_output":
          geminiRequest.contents.push({
            role: "user",
            parts: [ {
              functionResponse: {
                name: item.name,
                response: {
                  content: item.output
                }
              }
            } ]
          });
          break;
        }
      });
    }
    if (responsesRequest.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = responsesRequest.temperature;
    }
    if (responsesRequest.max_output_tokens !== undefined) {
      geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_output_tokens;
    } else if (responsesRequest.max_tokens !== undefined) {
      geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_tokens;
    }
    if (responsesRequest.top_p !== undefined) {
      geminiRequest.generationConfig.topP = responsesRequest.top_p;
    }
    if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
      geminiRequest.tools = [ {
        functionDeclarations: responsesRequest.tools.filter(tool => !tool.type || tool.type === "function").map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || tool.parametersJsonSchema || {
            type: "object",
            properties: {}
          }
        }))
      } ];
    }
    return geminiRequest;
  }
  toGeminiResponse(responsesResponse, model) {
    const parts = [];
    let finishReason = "STOP";
    if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
      responsesResponse.output.forEach(item => {
        if (item.type === "message") {
          const text = item.content?.filter(c => c.type === "output_text").map(c => c.text).join("") || "";
          if (text) {
            parts.push({
              text: text
            });
          }
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
          parts: parts,
          role: "model"
        },
        finishReason: finishReason,
        index: 0
      } ],
      usageMetadata: {
        promptTokenCount: responsesResponse.usage?.input_tokens || 0,
        candidatesTokenCount: responsesResponse.usage?.output_tokens || 0,
        totalTokenCount: responsesResponse.usage?.total_tokens || 0
      }
    };
  }
  toGeminiStreamChunk(responsesChunk, model) {
    if (responsesChunk.type === "response.output_text.delta") {
      return {
        candidates: [ {
          content: {
            parts: [ {
              text: responsesChunk.delta
            } ],
            role: "model"
          },
          index: 0
        } ]
      };
    }
    if (responsesChunk.type === "response.function_call_arguments.delta") {
      return {
        candidates: [ {
          content: {
            parts: [ {
              functionCall: {
                name: "",
                args: responsesChunk.delta
              }
            } ],
            role: "model"
          },
          index: 0
        } ]
      };
    }
    return null;
  }
  toCodexRequest(responsesRequest) {
    return this.codexConverter.toOpenAIResponsesToCodexRequest(responsesRequest);
  }
  toGrokRequest(responsesRequest) {
    const openaiRequest = this.toOpenAIRequest(responsesRequest);
    return {
      ...openaiRequest,
      _isConverted: true
    };
  }
  mapFinishReason(reason) {
    const reasonMap = {
      stop: "STOP",
      length: "MAX_TOKENS",
      content_filter: "SAFETY",
      end_turn: "STOP"
    };
    return reasonMap[reason] || "STOP";
  }
  toOpenAIModelList(responsesModels) {
    if (responsesModels.object === "list" && responsesModels.data) {
      return responsesModels;
    }
    return {
      object: "list",
      data: (responsesModels.models || responsesModels.data || []).map(m => ({
        id: m.id || m.name,
        object: "model",
        created: m.created || Math.floor(Date.now() / 1e3),
        owned_by: m.owned_by || "openai"
      }))
    };
  }
  toClaudeModelList(responsesModels) {
    const models = responsesModels.data || responsesModels.models || [];
    return {
      models: models.map(m => ({
        name: m.id || m.name,
        description: m.description || ""
      }))
    };
  }
  toGeminiModelList(responsesModels) {
    const models = responsesModels.data || responsesModels.models || [];
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
  toCodexResponse(codexResponse, model) {
    const output = [];
    const responseData = codexResponse.response || codexResponse;
    if (responseData.output && Array.isArray(responseData.output)) {
      responseData.output.forEach(item => {
        if (item.type === "message" && item.content) {
          const content = item.content.map(c => ({
            type: c.type === "output_text" ? "output_text" : "input_text",
            text: c.text,
            annotations: []
          }));
          output.push({
            id: item.id || `msg_${uuidv4().replace(/-/g, "")}`,
            type: "message",
            role: item.role || "assistant",
            status: item.status || "completed",
            content: content
          });
        } else if (item.type === "reasoning") {
          output.push({
            id: item.id || `rs_${uuidv4().replace(/-/g, "")}`,
            type: "reasoning",
            status: item.status || "completed",
            summary: item.summary || []
          });
        } else if (item.type === "function_call") {
          output.push({
            id: item.id || `fc_${uuidv4().replace(/-/g, "")}`,
            call_id: item.call_id,
            type: "function_call",
            name: item.name,
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments),
            status: item.status || "completed"
          });
        }
      });
    }
    return {
      id: responseData.id || `resp_${uuidv4().replace(/-/g, "")}`,
      object: "response",
      created_at: responseData.created_at || Math.floor(Date.now() / 1e3),
      model: model || responseData.model,
      status: responseData.status || "completed",
      output: output,
      usage: {
        input_tokens: responseData.usage?.input_tokens || 0,
        output_tokens: responseData.usage?.output_tokens || 0,
        total_tokens: responseData.usage?.total_tokens || 0
      }
    };
  }
  toCodexStreamChunk(codexChunk, model) {
    const type = codexChunk.type;
    const resId = codexChunk.response?.id || "default";
    const events = [];
    if (type === "response.created") {
      events.push(generateResponseCreated(resId, model || codexChunk.response?.model), generateResponseInProgress(resId));
      return events;
    }
    if (type === "response.reasoning_summary_text.delta") {
      events.push({
        type: "response.reasoning_summary_text.delta",
        response_id: resId,
        item_id: codexChunk.item_id,
        output_index: codexChunk.output_index,
        summary_index: codexChunk.summary_index,
        delta: codexChunk.delta
      });
      return events;
    }
    if (type === "response.output_text.delta") {
      events.push({
        type: "response.output_text.delta",
        response_id: resId,
        item_id: codexChunk.item_id,
        output_index: codexChunk.output_index,
        content_index: codexChunk.content_index,
        delta: codexChunk.delta
      });
      return events;
    }
    if (type === "response.function_call_arguments.delta") {
      events.push({
        type: "response.function_call_arguments.delta",
        response_id: resId,
        item_id: codexChunk.item_id,
        output_index: codexChunk.output_index,
        delta: codexChunk.delta
      });
      return events;
    }
    if (type === "response.output_item.added") {
      events.push({
        type: "response.output_item.added",
        response_id: resId,
        output_index: codexChunk.output_index,
        item: codexChunk.item
      });
      return events;
    }
    if (type === "response.completed") {
      const completedEvent = generateResponseCompleted(resId);
      completedEvent.response = {
        ...completedEvent.response,
        ...codexChunk.response
      };
      events.push(completedEvent);
      return events;
    }
    if (type && type.startsWith("response.")) {
      return [ codexChunk ];
    }
    return null;
  }
}