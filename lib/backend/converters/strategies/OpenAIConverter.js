import { v4 as uuidv4 } from "uuid";

import logger from "../../utils/logger.js";

import { BaseConverter } from "../BaseConverter.js";

import { CodexConverter } from "./CodexConverter.js";

import { extractAndProcessSystemMessages as extractSystemMessages, extractTextFromMessageContent as extractText, safeParseJSON, checkAndAssignOrDefault, extractThinkingFromOpenAIText, mapFinishReason, cleanJsonSchemaProperties as cleanJsonSchema, CLAUDE_DEFAULT_MAX_TOKENS, CLAUDE_DEFAULT_TEMPERATURE, CLAUDE_DEFAULT_TOP_P, GEMINI_DEFAULT_MAX_TOKENS, GEMINI_DEFAULT_TEMPERATURE, GEMINI_DEFAULT_TOP_P, OPENAI_DEFAULT_INPUT_TOKEN_LIMIT, OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT } from "../utils.js";

import { MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

import { generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted } from "../../providers/openai/openai-responses-core.mjs";

export class OpenAIConverter extends BaseConverter {
  constructor() {
    super("openai");
    this.codexConverter = new CodexConverter;
  }
  convertRequest(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeRequest(data);

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
     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesResponse(data, model);

     case MODEL_PROTOCOL_PREFIX.GROK:
      return this.toGrokResponse(data, model);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertStreamChunk(chunk, targetProtocol, model) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
      return this.toOpenAIResponsesStreamChunk(chunk, model);

     case MODEL_PROTOCOL_PREFIX.GROK:
      return this.toGrokStreamChunk(chunk, model);

     default:
      throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }
  }
  convertModelList(data, targetProtocol) {
    switch (targetProtocol) {
     case MODEL_PROTOCOL_PREFIX.CLAUDE:
      return this.toClaudeModelList(data);

     case MODEL_PROTOCOL_PREFIX.GEMINI:
      return this.toGeminiModelList(data);

     default:
      return this.ensureDisplayName(data);
    }
  }
  ensureDisplayName(openaiModels) {
    if (!openaiModels || !openaiModels.data) {
      return openaiModels;
    }
    return {
      ...openaiModels,
      data: openaiModels.data.map(model => ({
        ...model,
        display_name: model.display_name || model.id
      }))
    };
  }
  toClaudeRequest(openaiRequest) {
    const messages = openaiRequest.messages || [];
    const {systemInstruction: systemInstruction, nonSystemMessages: nonSystemMessages} = extractSystemMessages(messages);
    const claudeMessages = [];
    for (const message of nonSystemMessages) {
      const role = message.role === "assistant" ? "assistant" : "user";
      let content = [];
      if (message.role === "tool") {
        let toolContent = message.content;
        if (typeof toolContent === "object" && toolContent !== null) {
          toolContent = JSON.stringify(toolContent);
        }
        content.push({
          type: "tool_result",
          tool_use_id: message.tool_call_id || message.tool_use_id,
          content: toolContent
        });
        claudeMessages.push({
          role: "user",
          content: content
        });
      } else if (message.role === "assistant" && (message.tool_calls?.length || message.function_calls?.length)) {
        const calls = message.tool_calls || message.function_calls || [];
        const toolUseBlocks = calls.map(tc => ({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseJSON(tc.function.arguments)
        }));
        claudeMessages.push({
          role: "assistant",
          content: toolUseBlocks
        });
      } else {
        if (typeof message.content === "string") {
          if (message.content) {
            content.push({
              type: "text",
              text: message.content.trim()
            });
          }
        } else if (Array.isArray(message.content)) {
          message.content.forEach(item => {
            if (!item) return;
            switch (item.type) {
             case "text":
              if (item.text) {
                content.push({
                  type: "text",
                  text: item.text.trim()
                });
              }
              break;

             case "image_url":
              if (item.image_url) {
                const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
                if (imageUrl.startsWith("data:")) {
                  const [header, data] = imageUrl.split(",");
                  const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
                  content.push({
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mediaType,
                      data: data
                    }
                  });
                } else {
                  content.push({
                    type: "text",
                    text: `[Image: ${imageUrl}]`
                  });
                }
              }
              break;

             case "audio":
              if (item.audio_url) {
                const audioUrl = typeof item.audio_url === "string" ? item.audio_url : item.audio_url.url;
                content.push({
                  type: "text",
                  text: `[Audio: ${audioUrl}]`
                });
              }
              break;

             case "input_audio":
              if (item.input_audio) {
                content.push({
                  type: "text",
                  text: `[Audio Input: ${item.input_audio.format || "audio"}]`
                });
              }
              break;

             case "tool_use":
              content.push({
                type: "tool_use",
                id: item.id,
                name: item.name,
                input: typeof item.input === "string" ? safeParseJSON(item.input) : item.input || {}
              });
              break;

             case "tool_result":
              {
                let resultContent = item.content;
                if (typeof resultContent === "object" && resultContent !== null) {
                  resultContent = JSON.stringify(resultContent);
                }
                content.push({
                  type: "tool_result",
                  tool_use_id: item.tool_use_id || item.id,
                  content: resultContent
                });
                break;
              }
            }
          });
        }
        if (content.length > 0) {
          claudeMessages.push({
            role: role,
            content: content
          });
        }
      }
    }
    const mergedClaudeMessages = [];
    for (let i = 0; i < claudeMessages.length; i++) {
      const currentMessage = claudeMessages[i];
      if (mergedClaudeMessages.length === 0) {
        mergedClaudeMessages.push(currentMessage);
      } else {
        const lastMessage = mergedClaudeMessages[mergedClaudeMessages.length - 1];
        if (lastMessage.role === currentMessage.role) {
          lastMessage.content = lastMessage.content.concat(currentMessage.content);
        } else {
          mergedClaudeMessages.push(currentMessage);
        }
      }
    }
    if (mergedClaudeMessages.length > 0) {
      const lastMessage = mergedClaudeMessages[mergedClaudeMessages.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        for (let i = lastMessage.content.length - 1; i >= 0; i--) {
          const contentBlock = lastMessage.content[i];
          if (contentBlock.type === "text" && contentBlock.text) {
            contentBlock.text = contentBlock.text.trimEnd();
            break;
          }
        }
      }
    }
    const claudeRequest = {
      model: openaiRequest.model,
      messages: mergedClaudeMessages,
      max_tokens: checkAndAssignOrDefault(openaiRequest.max_tokens, CLAUDE_DEFAULT_MAX_TOKENS),
      temperature: checkAndAssignOrDefault(openaiRequest.temperature, CLAUDE_DEFAULT_TEMPERATURE),
      top_p: checkAndAssignOrDefault(openaiRequest.top_p, CLAUDE_DEFAULT_TOP_P)
    };
    if (systemInstruction) {
      claudeRequest.system = extractText(systemInstruction.parts[0].text);
    }
    if (openaiRequest.tools?.length) {
      claudeRequest.tools = openaiRequest.tools.filter(t => t && (t.function && t.function.name || t.name)).map(t => {
        if (t.function) {
          return {
            name: t.function.name,
            description: t.function.description || "",
            input_schema: t.function.parameters || {
              type: "object",
              properties: {}
            }
          };
        }
        return {
          name: t.name,
          description: t.description || "",
          input_schema: t.input_schema || {
            type: "object",
            properties: {}
          }
        };
      });
      if (claudeRequest.tools.length > 0) {
        claudeRequest.tool_choice = this.buildClaudeToolChoice(openaiRequest.tool_choice);
      }
    }
    const extThinking = openaiRequest?.extra_body?.anthropic?.thinking;
    if (extThinking && typeof extThinking === "object" && !Array.isArray(extThinking)) {
      const type = String(extThinking.type || "").toLowerCase().trim();
      if (type === "enabled") {
        const thinkingCfg = {
          type: "enabled"
        };
        if (extThinking.budget_tokens !== undefined) {
          const n = parseInt(extThinking.budget_tokens, 10);
          if (Number.isFinite(n)) {
            thinkingCfg.budget_tokens = n;
          }
        }
        claudeRequest.thinking = thinkingCfg;
      } else if (type === "adaptive") {
        const effortRaw = typeof extThinking.effort === "string" ? extThinking.effort : "";
        const effort = effortRaw.toLowerCase().trim();
        const normalizedEffort = effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
        claudeRequest.thinking = {
          type: "adaptive",
          effort: normalizedEffort
        };
      } else if (type === "disabled") {}
    }
    return claudeRequest;
  }
  toClaudeResponse(openaiResponse, model) {
    if (!openaiResponse || !openaiResponse.choices || openaiResponse.choices.length === 0) {
      return {
        id: `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: openaiResponse?.usage?.prompt_tokens || 0,
          output_tokens: openaiResponse?.usage?.completion_tokens || 0
        }
      };
    }
    const choice = openaiResponse.choices[0];
    const contentList = [];
    const toolCalls = choice.message?.tool_calls || choice.message?.function_calls || [];
    for (const toolCall of toolCalls.filter(tc => tc && typeof tc === "object")) {
      if (toolCall.function) {
        const func = toolCall.function;
        const argStr = func.arguments || "{}";
        let argObj;
        try {
          argObj = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
        } catch (e) {
          argObj = {};
        }
        contentList.push({
          type: "tool_use",
          id: toolCall.id || "",
          name: func.name || "",
          input: argObj
        });
      }
    }
    const reasoningContent = choice.message?.reasoning_content || "";
    if (reasoningContent) {
      contentList.push({
        type: "thinking",
        thinking: reasoningContent
      });
    }
    const contentText = choice.message?.content || "";
    if (contentText) {
      const extractedContent = extractThinkingFromOpenAIText(contentText);
      if (Array.isArray(extractedContent)) {
        contentList.push(...extractedContent);
      } else {
        contentList.push({
          type: "text",
          text: extractedContent
        });
      }
    }
    const stopReason = mapFinishReason(choice.finish_reason || "stop", "openai", "anthropic");
    return {
      id: `msg_${uuidv4()}`,
      type: "message",
      role: "assistant",
      content: contentList,
      model: model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: openaiResponse.usage?.prompt_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
        output_tokens: openaiResponse.usage?.completion_tokens || 0
      }
    };
  }
  toClaudeStreamChunk(openaiChunk, model) {
    if (!openaiChunk) return null;
    if (typeof openaiChunk === "object" && !Array.isArray(openaiChunk)) {
      const choice = openaiChunk.choices?.[0];
      if (!choice) {
        return null;
      }
      const delta = choice.delta;
      const finishReason = choice.finish_reason;
      const events = [];
      if (delta?.reasoning_content) {
        events.push({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: delta.reasoning_content
          }
        });
      }
      if (delta?.content) {
        events.push({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: delta.content
          }
        });
      }
      if (finishReason) {
        const stopReason = finishReason === "stop" ? "end_turn" : finishReason === "length" ? "max_tokens" : "end_turn";
        events.push({
          type: "content_block_stop",
          index: 0
        });
        events.push({
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null
          },
          usage: {
            input_tokens: openaiChunk.usage?.prompt_tokens || 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: openaiChunk.usage?.prompt_tokens_details?.cached_tokens || 0,
            output_tokens: openaiChunk.usage?.completion_tokens || 0
          }
        });
        events.push({
          type: "message_stop"
        });
      }
      return events.length > 0 ? events : null;
    }
    if (typeof openaiChunk === "string") {
      return {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: openaiChunk
        }
      };
    }
    return null;
  }
  toClaudeModelList(openaiModels) {
    return {
      models: openaiModels.data.map(m => ({
        name: m.id,
        description: ""
      }))
    };
  }
  toGeminiModelList(openaiModels) {
    const models = openaiModels.data || [];
    return {
      models: models.map(m => ({
        name: `models/${m.id}`,
        version: m.version || "1.0.0",
        displayName: m.displayName || m.id,
        description: m.description || `A generative model for text and chat generation. ID: ${m.id}`,
        inputTokenLimit: m.inputTokenLimit || OPENAI_DEFAULT_INPUT_TOKEN_LIMIT,
        outputTokenLimit: m.outputTokenLimit || OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT,
        supportedGenerationMethods: m.supportedGenerationMethods || [ "generateContent", "streamGenerateContent" ]
      }))
    };
  }
  buildClaudeToolChoice(toolChoice) {
    if (typeof toolChoice === "string") {
      const mapping = {
        auto: "auto",
        none: "none",
        required: "any"
      };
      return {
        type: mapping[toolChoice]
      };
    }
    if (typeof toolChoice === "object") {
      if (toolChoice.type && toolChoice.name) {
        return {
          type: toolChoice.type,
          name: toolChoice.name
        };
      }
      if (toolChoice.function) {
        return {
          type: "tool",
          name: toolChoice.function.name
        };
      }
    }
    return undefined;
  }
  static GEMINI_OPENAI_THOUGHT_SIGNATURE="skip_thought_signature_validator";
  toGeminiRequest(openaiRequest) {
    const messages = openaiRequest.messages || [];
    const model = openaiRequest.model || "";
    const tcID2Name = {};
    for (const message of messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const tc of message.tool_calls) {
          if (tc.type === "function" && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item && item.type === "tool_use" && item.id && item.name) {
            tcID2Name[item.id] = item.name;
          }
        }
      }
    }
    const toolResponses = {};
    for (const message of messages) {
      if (message.role === "tool" && message.tool_call_id) {
        toolResponses[message.tool_call_id] = message.content;
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item && item.type === "tool_result" && item.tool_use_id) {
            toolResponses[item.tool_use_id] = item.content;
          }
        }
      }
    }
    const processedMessages = [];
    let systemInstruction = null;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const role = message.role;
      const content = message.content;
      if (role === "system" || role === "developer") {
        if (messages.length > 1) {
          if (typeof content === "string") {
            systemInstruction = {
              role: "user",
              parts: [ {
                text: content
              } ]
            };
          } else if (Array.isArray(content)) {
            const parts = content.filter(item => item.type === "text" && item.text).map(item => ({
              text: item.text
            }));
            if (parts.length > 0) {
              systemInstruction = {
                role: "user",
                parts: parts
              };
            }
          } else if (typeof content === "object" && content.type === "text") {
            systemInstruction = {
              role: "user",
              parts: [ {
                text: content.text
              } ]
            };
          }
        } else {
          const node = {
            role: "user",
            parts: []
          };
          if (typeof content === "string") {
            node.parts.push({
              text: content
            });
          } else if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "text" && item.text) {
                node.parts.push({
                  text: item.text
                });
              }
            }
          }
          if (node.parts.length > 0) {
            processedMessages.push(node);
          }
        }
      } else if (role === "user") {
        const node = {
          role: "user",
          parts: []
        };
        if (typeof content === "string") {
          node.parts.push({
            text: content
          });
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (!item) continue;
            switch (item.type) {
             case "text":
              if (item.text) {
                node.parts.push({
                  text: item.text
                });
              }
              break;

             case "image_url":
              if (item.image_url) {
                const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
                if (imageUrl && imageUrl.startsWith("data:")) {
                  const commaIndex = imageUrl.indexOf(",");
                  if (commaIndex > 5) {
                    const header = imageUrl.substring(5, commaIndex);
                    const semicolonIndex = header.indexOf(";");
                    if (semicolonIndex > 0) {
                      const mimeType = header.substring(0, semicolonIndex);
                      const data = imageUrl.substring(commaIndex + 1);
                      node.parts.push({
                        inlineData: {
                          mimeType: mimeType,
                          data: data
                        },
                        thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                      });
                    }
                  }
                } else if (imageUrl) {
                  node.parts.push({
                    fileData: {
                      mimeType: "image/jpeg",
                      fileUri: imageUrl
                    }
                  });
                }
              }
              break;

             case "file":
              if (item.file) {
                const filename = item.file.filename || "";
                const fileData = item.file.file_data || "";
                const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
                const mimeTypes = {
                  pdf: "application/pdf",
                  txt: "text/plain",
                  html: "text/html",
                  css: "text/css",
                  js: "application/javascript",
                  json: "application/json",
                  xml: "application/xml",
                  csv: "text/csv",
                  md: "text/markdown",
                  py: "text/x-python",
                  java: "text/x-java",
                  c: "text/x-c",
                  cpp: "text/x-c++",
                  h: "text/x-c",
                  hpp: "text/x-c++",
                  go: "text/x-go",
                  rs: "text/x-rust",
                  ts: "text/typescript",
                  tsx: "text/typescript",
                  jsx: "text/javascript",
                  png: "image/png",
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  gif: "image/gif",
                  webp: "image/webp",
                  svg: "image/svg+xml",
                  mp3: "audio/mpeg",
                  wav: "audio/wav",
                  mp4: "video/mp4",
                  webm: "video/webm"
                };
                const mimeType = mimeTypes[ext];
                if (mimeType && fileData) {
                  node.parts.push({
                    inlineData: {
                      mimeType: mimeType,
                      data: fileData
                    }
                  });
                }
              }
              break;
            }
          }
        }
        if (node.parts.length > 0) {
          processedMessages.push(node);
        }
      } else if (role === "assistant") {
        const node = {
          role: "model",
          parts: []
        };
        const functionCallIds = [];
        if (typeof content === "string" && content) {
          node.parts.push({
            text: content
          });
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (!item) continue;
            if (item.type === "text" && item.text) {
              node.parts.push({
                text: item.text
              });
            } else if (item.type === "tool_use") {
              const fid = item.id || "";
              const fname = item.name || "";
              const argsObj = typeof item.input === "string" ? (() => {
                try {
                  return JSON.parse(item.input);
                } catch (e) {
                  return {};
                }
              })() : item.input || {};
              node.parts.push({
                functionCall: {
                  name: fname,
                  args: argsObj
                },
                thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
              });
              if (fid) functionCallIds.push(fid);
            } else if (item.type === "image_url" && item.image_url) {
              const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
              if (imageUrl && imageUrl.startsWith("data:")) {
                const commaIndex = imageUrl.indexOf(",");
                if (commaIndex > 5) {
                  const header = imageUrl.substring(5, commaIndex);
                  const semicolonIndex = header.indexOf(";");
                  if (semicolonIndex > 0) {
                    const mimeType = header.substring(0, semicolonIndex);
                    const data = imageUrl.substring(commaIndex + 1);
                    node.parts.push({
                      inlineData: {
                        mimeType: mimeType,
                        data: data
                      },
                      thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                    });
                  }
                }
              }
            }
          }
        }
        if (message.tool_calls && Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            if (tc.type !== "function") continue;
            const fid = tc.id || "";
            const fname = tc.function?.name || "";
            const fargs = tc.function?.arguments || "{}";
            let argsObj;
            try {
              argsObj = typeof fargs === "string" ? JSON.parse(fargs) : fargs;
            } catch (e) {
              argsObj = {};
            }
            node.parts.push({
              functionCall: {
                name: fname,
                args: argsObj
              },
              thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
            });
            if (fid) {
              functionCallIds.push(fid);
            }
          }
        }
        if (node.parts.length > 0) {
          processedMessages.push(node);
        }
        if (functionCallIds.length > 0) {
          const toolNode = {
            role: "user",
            parts: []
          };
          for (const fid of functionCallIds) {
            const name = tcID2Name[fid];
            if (name) {
              let resp = toolResponses[fid] || "{}";
              if (typeof resp !== "string") {
                resp = JSON.stringify(resp);
              }
              toolNode.parts.push({
                functionResponse: {
                  name: name,
                  response: {
                    result: resp
                  }
                }
              });
            }
          }
          if (toolNode.parts.length > 0) {
            processedMessages.push(toolNode);
          }
        }
      } else if (role === "tool") {
        const toolNode = {
          role: "user",
          parts: []
        };
        const toolCallId = message.tool_call_id;
        const functionName = tcID2Name[toolCallId];
        if (functionName) {
          let responseContent = message.content;
          if (typeof responseContent !== "string") {
            responseContent = JSON.stringify(responseContent);
          }
          toolNode.parts.push({
            functionResponse: {
              name: functionName,
              response: {
                result: responseContent
              }
            }
          });
          if (toolNode.parts.length > 0) {
            processedMessages.push(toolNode);
          }
        }
      }
    }
    const geminiRequest = {
      contents: processedMessages.filter(item => item.parts && item.parts.length > 0)
    };
    if (model) {
      geminiRequest.model = model;
    }
    if (systemInstruction) {
      geminiRequest.system_instruction = systemInstruction;
    }
    if (openaiRequest.reasoning_effort) {
      const effort = String(openaiRequest.reasoning_effort).toLowerCase().trim();
      if (this.modelSupportsThinking(model)) {
        if (this.isGemini3Model(model)) {
          if (effort === "none") {} else if (effort === "auto") {
            geminiRequest.generationConfig = geminiRequest.generationConfig || {};
            geminiRequest.generationConfig.thinkingConfig = {
              includeThoughts: true
            };
          } else {
            const level = this.validateGemini3ThinkingLevel(model, effort);
            if (level) {
              geminiRequest.generationConfig = geminiRequest.generationConfig || {};
              geminiRequest.generationConfig.thinkingConfig = {
                thinkingLevel: level
              };
            }
          }
        } else if (!this.modelUsesThinkingLevels(model)) {
          geminiRequest.generationConfig = geminiRequest.generationConfig || {};
          geminiRequest.generationConfig.thinkingConfig = this.applyReasoningEffortToGemini(effort);
        }
      }
    }
    if (!openaiRequest.reasoning_effort && openaiRequest.extra_body?.google?.thinking_config) {
      const tc = openaiRequest.extra_body.google.thinking_config;
      if (this.modelSupportsThinking(model) && !this.modelUsesThinkingLevels(model)) {
        geminiRequest.generationConfig = geminiRequest.generationConfig || {};
        geminiRequest.generationConfig.thinkingConfig = geminiRequest.generationConfig.thinkingConfig || {};
        let setBudget = false;
        let budget = 0;
        if (tc.thinkingBudget !== undefined) {
          budget = parseInt(tc.thinkingBudget, 10);
          geminiRequest.generationConfig.thinkingConfig.thinkingBudget = budget;
          setBudget = true;
        } else if (tc.thinking_budget !== undefined) {
          budget = parseInt(tc.thinking_budget, 10);
          geminiRequest.generationConfig.thinkingConfig.thinkingBudget = budget;
          setBudget = true;
        }
        if (tc.includeThoughts !== undefined) {
          geminiRequest.generationConfig.thinkingConfig.includeThoughts = tc.includeThoughts;
        } else if (tc.include_thoughts !== undefined) {
          geminiRequest.generationConfig.thinkingConfig.includeThoughts = tc.include_thoughts;
        } else if (setBudget && budget !== 0) {
          geminiRequest.generationConfig.thinkingConfig.includeThoughts = true;
        }
      }
    }
    if (openaiRequest.modalities && Array.isArray(openaiRequest.modalities)) {
      const responseMods = [];
      for (const m of openaiRequest.modalities) {
        const mod = String(m).toLowerCase();
        if (mod === "text") {
          responseMods.push("TEXT");
        } else if (mod === "image") {
          responseMods.push("IMAGE");
        }
      }
      if (responseMods.length > 0) {
        geminiRequest.generationConfig = geminiRequest.generationConfig || {};
        geminiRequest.generationConfig.responseModalities = responseMods;
      }
    }
    if (openaiRequest.image_config) {
      const imgCfg = openaiRequest.image_config;
      if (imgCfg.aspect_ratio) {
        geminiRequest.generationConfig = geminiRequest.generationConfig || {};
        geminiRequest.generationConfig.imageConfig = geminiRequest.generationConfig.imageConfig || {};
        geminiRequest.generationConfig.imageConfig.aspectRatio = imgCfg.aspect_ratio;
      }
      if (imgCfg.image_size) {
        geminiRequest.generationConfig = geminiRequest.generationConfig || {};
        geminiRequest.generationConfig.imageConfig = geminiRequest.generationConfig.imageConfig || {};
        geminiRequest.generationConfig.imageConfig.imageSize = imgCfg.image_size;
      }
    }
    if (openaiRequest.tools?.length) {
      const functionDeclarations = [];
      let hasGoogleSearch = false;
      let hasUrlContext = false;
      let hasGoogleMaps = false;
      for (const t of openaiRequest.tools) {
        if (!t || typeof t !== "object") continue;
        if (t.type === "function" && t.function) {
          const func = t.function;
          let fnDecl = {
            name: String(func.name || ""),
            description: String(func.description || "")
          };
          if (func.parameters) {
            fnDecl.parametersJsonSchema = cleanJsonSchema(func.parameters);
          } else {
            fnDecl.parametersJsonSchema = {
              type: "object",
              properties: {}
            };
          }
          functionDeclarations.push(fnDecl);
        } else if (t.name) {
          functionDeclarations.push({
            name: String(t.name),
            description: String(t.description || ""),
            parametersJsonSchema: cleanJsonSchema(t.input_schema || {
              type: "object",
              properties: {}
            })
          });
        }
        if (t.google_search) {
          hasGoogleSearch = true;
        }
        if (t.url_context) {
          hasUrlContext = true;
        }
        if (t.google_maps) {
          hasGoogleMaps = true;
        }
      }
      if (functionDeclarations.length > 0 || hasGoogleSearch || hasUrlContext || hasGoogleMaps) {
        geminiRequest.tools = [];
        if (functionDeclarations.length > 0) {
          geminiRequest.tools.push({
            functionDeclarations: functionDeclarations
          });
        }
        if (hasGoogleSearch) {
          const googleSearchTool = openaiRequest.tools.find(t => t.google_search);
          geminiRequest.tools.push({
            googleSearch: googleSearchTool.google_search
          });
        }
        if (hasUrlContext) {
          const urlContextTool = openaiRequest.tools.find(t => t.url_context);
          geminiRequest.tools.push({
            urlContext: urlContextTool.url_context
          });
        }
        if (hasGoogleMaps) {
          const googleMapsTool = openaiRequest.tools.find(t => t.google_maps);
          geminiRequest.tools.push({
            googleMaps: googleMapsTool.google_maps
          });
        }
      }
    }
    if (openaiRequest.tool_choice) {
      geminiRequest.toolConfig = this.buildGeminiToolConfig(openaiRequest.tool_choice);
    }
    const config = this.buildGeminiGenerationConfig(openaiRequest, model);
    if (Object.keys(config).length) {
      geminiRequest.generationConfig = {
        ...config,
        ...geminiRequest.generationConfig || {}
      };
    }
    geminiRequest.safetySettings = this.getDefaultSafetySettings();
    return geminiRequest;
  }
  modelSupportsThinking(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return m.includes("2.5") || m.includes("thinking") || m.includes("2.0-flash-thinking");
  }
  isGemini3Model(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return m.includes("gemini-3") || m.includes("gemini3");
  }
  modelUsesThinkingLevels(model) {
    if (!model) return false;
    return this.isGemini3Model(model);
  }
  validateGemini3ThinkingLevel(model, effort) {
    const validLevels = [ "low", "medium", "high" ];
    if (validLevels.includes(effort)) {
      return effort.toUpperCase();
    }
    return null;
  }
  applyReasoningEffortToGemini(effort) {
    const effortToBudget = {
      low: 1024,
      medium: 8192,
      high: 24576
    };
    const budget = effortToBudget[effort] || effortToBudget["medium"];
    return {
      thinkingBudget: budget,
      includeThoughts: true
    };
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
  processOpenAIContentToGeminiParts(content) {
    if (!content) return [];
    if (typeof content === "string") return [ {
      text: content
    } ];
    if (Array.isArray(content)) {
      const parts = [];
      for (const item of content) {
        if (!item) continue;
        if (item.type === "text" && item.text) {
          parts.push({
            text: item.text
          });
        } else if (item.type === "image_url" && item.image_url) {
          const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
          if (imageUrl.startsWith("data:")) {
            const [header, data] = imageUrl.split(",");
            const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
            parts.push({
              inlineData: {
                mimeType: mimeType,
                data: data
              }
            });
          } else {
            parts.push({
              fileData: {
                mimeType: "image/jpeg",
                fileUri: imageUrl
              }
            });
          }
        }
      }
      return parts;
    }
    return [];
  }
  buildGeminiToolConfig(toolChoice) {
    if (typeof toolChoice === "string" && [ "none", "auto" ].includes(toolChoice)) {
      return {
        functionCallingConfig: {
          mode: toolChoice.toUpperCase()
        }
      };
    }
    if (typeof toolChoice === "object" && toolChoice.function) {
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [ toolChoice.function.name ]
        }
      };
    }
    return null;
  }
  buildGeminiGenerationConfig({temperature: temperature, max_tokens: max_tokens, top_p: top_p, stop: stop, tools: tools, response_format: response_format}, model) {
    const config = {};
    config.temperature = checkAndAssignOrDefault(temperature, GEMINI_DEFAULT_TEMPERATURE);
    config.maxOutputTokens = checkAndAssignOrDefault(max_tokens, GEMINI_DEFAULT_MAX_TOKENS);
    config.topP = checkAndAssignOrDefault(top_p, GEMINI_DEFAULT_TOP_P);
    if (stop !== undefined) config.stopSequences = Array.isArray(stop) ? stop : [ stop ];
    if (response_format) {
      if (response_format.type === "json_object") {
        config.responseMimeType = "application/json";
      } else if (response_format.type === "json_schema" && response_format.json_schema) {
        config.responseMimeType = "application/json";
        if (response_format.json_schema.schema) {
          config.responseSchema = response_format.json_schema.schema;
        }
      }
    }
    const hasTools = tools && Array.isArray(tools) && tools.length > 0;
    if (!hasTools && model && (model.includes("2.5") || model.includes("thinking") || model.includes("2.0-flash-thinking"))) {
      logger.info(`[OpenAI->Gemini] Adding responseModalities: ["TEXT"] for model: ${model}`);
      config.responseModalities = [ "TEXT" ];
    } else if (hasTools && model && (model.includes("2.5") || model.includes("thinking") || model.includes("2.0-flash-thinking"))) {
      logger.info(`[OpenAI->Gemini] Skipping responseModalities for model ${model} because tools are present`);
    }
    return config;
  }
  toGeminiResponse(openaiResponse, model) {
    if (!openaiResponse || !openaiResponse.choices || !openaiResponse.choices[0]) {
      return {
        candidates: [],
        usageMetadata: {}
      };
    }
    const choice = openaiResponse.choices[0];
    const message = choice.message || {};
    const parts = [];
    if (message.content) {
      parts.push({
        text: message.content
      });
    }
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === "function") {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: typeof toolCall.function.arguments === "string" ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments
            }
          });
        }
      }
    }
    const finishReasonMap = {
      stop: "STOP",
      length: "MAX_TOKENS",
      tool_calls: "STOP",
      content_filter: "SAFETY"
    };
    return {
      candidates: [ {
        content: {
          role: "model",
          parts: parts
        },
        finishReason: finishReasonMap[choice.finish_reason] || "STOP"
      } ],
      usageMetadata: openaiResponse.usage ? {
        promptTokenCount: openaiResponse.usage.prompt_tokens || 0,
        candidatesTokenCount: openaiResponse.usage.completion_tokens || 0,
        totalTokenCount: openaiResponse.usage.total_tokens || 0,
        cachedContentTokenCount: openaiResponse.usage.prompt_tokens_details?.cached_tokens || 0,
        promptTokensDetails: [ {
          modality: "TEXT",
          tokenCount: openaiResponse.usage.prompt_tokens || 0
        } ],
        candidatesTokensDetails: [ {
          modality: "TEXT",
          tokenCount: openaiResponse.usage.completion_tokens || 0
        } ],
        thoughtsTokenCount: openaiResponse.usage.completion_tokens_details?.reasoning_tokens || 0
      } : {}
    };
  }
  toGeminiStreamChunk(openaiChunk, model) {
    if (!openaiChunk || !openaiChunk.choices || !openaiChunk.choices[0]) {
      return null;
    }
    const choice = openaiChunk.choices[0];
    const delta = choice.delta || {};
    const parts = [];
    if (delta.content) {
      parts.push({
        text: delta.content
      });
    }
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const toolCall of delta.tool_calls) {
        if (toolCall.function) {
          const functionCall = {
            name: toolCall.function.name || "",
            args: {}
          };
          if (toolCall.function.arguments) {
            try {
              functionCall.args = typeof toolCall.function.arguments === "string" ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;
            } catch (e) {
              functionCall.args = {
                partial: toolCall.function.arguments
              };
            }
          }
          parts.push({
            functionCall: functionCall
          });
        }
      }
    }
    const result = {
      candidates: [ {
        content: {
          role: "model",
          parts: parts
        }
      } ]
    };
    return result;
  }
  toGrokRequest(openaiRequest) {
    const {ConverterFactory: ConverterFactory} = import.meta.url ? {
      ConverterFactory: null
    } : {
      ConverterFactory: null
    };
    return {
      ...openaiRequest,
      _isConverted: true
    };
  }
  toGrokResponse(openaiResponse, model) {
    return openaiResponse;
  }
  toGrokStreamChunk(openaiChunk, model) {
    return openaiChunk;
  }
  toGrokModelList(openaiModels) {
    return openaiModels;
  }
  toCodexRequest(openaiRequest) {
    return this.codexConverter.toOpenAIRequestToCodexRequest(openaiRequest);
  }
  toOpenAIResponsesRequest(openaiRequest) {
    const responsesRequest = {
      model: openaiRequest.model,
      instructions: "",
      input: [],
      stream: openaiRequest.stream || false,
      max_output_tokens: openaiRequest.max_tokens,
      temperature: openaiRequest.temperature,
      top_p: openaiRequest.top_p,
      parallel_tool_calls: openaiRequest.parallel_tool_calls,
      tool_choice: openaiRequest.tool_choice
    };
    const {systemInstruction: systemInstruction, nonSystemMessages: nonSystemMessages} = extractSystemMessages(openaiRequest.messages || []);
    if (systemInstruction) {
      responsesRequest.instructions = extractText(systemInstruction.parts[0].text);
    }
    if (openaiRequest.reasoning_effort) {
      responsesRequest.reasoning = {
        effort: openaiRequest.reasoning_effort
      };
    }
    for (const msg of nonSystemMessages) {
      if (msg.role === "tool") {
        responsesRequest.input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: msg.content
        });
      } else if (msg.role === "assistant" && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          responsesRequest.input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments
          });
        }
      } else {
        let content = [];
        if (typeof msg.content === "string") {
          content.push({
            type: msg.role === "assistant" ? "output_text" : "input_text",
            text: msg.content
          });
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach(c => {
            if (c.type === "text") {
              content.push({
                type: msg.role === "assistant" ? "output_text" : "input_text",
                text: c.text
              });
            } else if (c.type === "image_url") {
              content.push({
                type: "input_image",
                image_url: c.image_url
              });
            }
          });
        }
        if (content.length > 0) {
          responsesRequest.input.push({
            type: "message",
            role: msg.role,
            content: content
          });
        }
      }
    }
    if (openaiRequest.tools) {
      responsesRequest.tools = openaiRequest.tools.map(t => ({
        type: t.type || "function",
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters
      }));
    }
    return responsesRequest;
  }
  toOpenAIResponsesResponse(openaiResponse, model) {
    if (!openaiResponse || !openaiResponse.choices || !openaiResponse.choices[0]) {
      return {
        id: `resp_${Date.now()}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1e3),
        status: "completed",
        model: model || "unknown",
        output: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        }
      };
    }
    const choice = openaiResponse.choices[0];
    const message = choice.message || {};
    const output = [];
    const messageContent = [];
    if (message.content) {
      messageContent.push({
        type: "output_text",
        text: message.content
      });
    }
    output.push({
      type: "message",
      id: `msg_${Date.now()}`,
      status: "completed",
      role: "assistant",
      content: messageContent
    });
    return {
      id: openaiResponse.id || `resp_${Date.now()}`,
      object: "response",
      created_at: openaiResponse.created || Math.floor(Date.now() / 1e3),
      status: choice.finish_reason === "stop" ? "completed" : "in_progress",
      model: model || openaiResponse.model || "unknown",
      output: output,
      usage: openaiResponse.usage ? {
        input_tokens: openaiResponse.usage.prompt_tokens || 0,
        input_tokens_details: {
          cached_tokens: openaiResponse.usage.prompt_tokens_details?.cached_tokens || 0
        },
        output_tokens: openaiResponse.usage.completion_tokens || 0,
        output_tokens_details: {
          reasoning_tokens: openaiResponse.usage.completion_tokens_details?.reasoning_tokens || 0
        },
        total_tokens: openaiResponse.usage.total_tokens || 0
      } : {
        input_tokens: 0,
        input_tokens_details: {
          cached_tokens: 0
        },
        output_tokens: 0,
        output_tokens_details: {
          reasoning_tokens: 0
        },
        total_tokens: 0
      }
    };
  }
  toOpenAIResponsesStreamChunk(openaiChunk, model, requestId = null) {
    if (!openaiChunk || !openaiChunk.choices || !openaiChunk.choices[0]) {
      return [];
    }
    const responseId = requestId || `resp_${uuidv4().replace(/-/g, "")}`;
    const choice = openaiChunk.choices[0];
    const delta = choice.delta || {};
    const events = [];
    if (delta.role === "assistant") {
      events.push(generateResponseCreated(responseId, model || openaiChunk.model || "unknown"), generateResponseInProgress(responseId), generateOutputItemAdded(responseId), generateContentPartAdded(responseId));
    }
    if (delta.reasoning_content) {
      events.push({
        delta: delta.reasoning_content,
        item_id: `thinking_${uuidv4().replace(/-/g, "")}`,
        output_index: 0,
        sequence_number: 3,
        type: "response.reasoning_summary_text.delta"
      });
    }
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const toolCall of delta.tool_calls) {
        const outputIndex = toolCall.index || 0;
        if (toolCall.function && toolCall.function.name) {
          events.push({
            item: {
              id: toolCall.id || `call_${uuidv4().replace(/-/g, "")}`,
              type: "function_call",
              name: toolCall.function.name,
              arguments: "",
              status: "in_progress"
            },
            output_index: outputIndex,
            sequence_number: 2,
            type: "response.output_item.added"
          });
        }
        if (toolCall.function && toolCall.function.arguments) {
          events.push({
            delta: toolCall.function.arguments,
            item_id: toolCall.id || `call_${uuidv4().replace(/-/g, "")}`,
            output_index: outputIndex,
            sequence_number: 3,
            type: "response.custom_tool_call_input.delta"
          });
        }
      }
    }
    if (delta.content) {
      events.push({
        delta: delta.content,
        item_id: `msg_${uuidv4().replace(/-/g, "")}`,
        output_index: 0,
        sequence_number: 3,
        type: "response.output_text.delta"
      });
    }
    if (choice.finish_reason) {
      events.push(generateOutputTextDone(responseId), generateContentPartDone(responseId), generateOutputItemDone(responseId), generateResponseCompleted(responseId));
      if (openaiChunk.usage && events.length > 0) {
        const lastEvent = events[events.length - 1];
        if (lastEvent.response) {
          lastEvent.response.usage = {
            input_tokens: openaiChunk.usage.prompt_tokens || 0,
            input_tokens_details: {
              cached_tokens: openaiChunk.usage.prompt_tokens_details?.cached_tokens || 0
            },
            output_tokens: openaiChunk.usage.completion_tokens || 0,
            output_tokens_details: {
              reasoning_tokens: openaiChunk.usage.completion_tokens_details?.reasoning_tokens || 0
            },
            total_tokens: openaiChunk.usage.total_tokens || 0
          };
        }
      }
    }
    return events;
  }
}

export default OpenAIConverter;