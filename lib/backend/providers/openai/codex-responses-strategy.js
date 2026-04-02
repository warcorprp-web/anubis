import { ProviderStrategy } from "../../utils/provider-strategy.js";

import logger from "../../utils/logger.js";

import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

class CodexResponsesAPIStrategy extends ProviderStrategy {
  extractModelAndStreamInfo(req, requestBody) {
    const model = requestBody.model;
    const isStream = requestBody.stream === true;
    return {
      model: model,
      isStream: isStream
    };
  }
  extractResponseText(response) {
    if (!response.output) {
      return "";
    }
    for (const item of response.output) {
      if (item.type === "message" && item.content && item.content.length > 0) {
        for (const content of item.content) {
          if (content.type === "output_text" && content.text) {
            return content.text;
          }
        }
      }
    }
    return "";
  }
  extractPromptText(requestBody) {
    if (typeof requestBody.input === "string") {
      return requestBody.input;
    } else if (Array.isArray(requestBody.input)) {
      const userInputItems = requestBody.input.filter(item => item.role && item.role === "user" || item.type && item.type === "message" && item.role === "user" || item.type && item.type === "user");
      if (userInputItems.length > 0) {
        const lastInput = userInputItems[userInputItems.length - 1];
        if (typeof lastInput.content === "string") {
          return lastInput.content;
        } else if (Array.isArray(lastInput.content)) {
          return lastInput.content.map(item => item.text || item.content || "").join("\n");
        }
      }
    }
    return "";
  }
  async applySystemPromptFromFile(config, requestBody) {
    if (!config.SYSTEM_PROMPT_FILE_PATH) {
      return requestBody;
    }
    const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
    if (filePromptContent === null) {
      return requestBody;
    }
    requestBody.instructions = requestBody.instructions || filePromptContent;
    if (!requestBody.instructions || config.SYSTEM_PROMPT_MODE === "append") {
      if (typeof requestBody.input === "string") {
        requestBody.input = [ {
          type: "message",
          role: "developer",
          content: filePromptContent
        }, {
          type: "message",
          role: "user",
          content: requestBody.input
        } ];
      } else if (Array.isArray(requestBody.input)) {
        const systemMessageIndex = requestBody.input.findIndex(m => m.role === "developer" || m.type && m.type === "developer");
        if (systemMessageIndex !== -1) {
          requestBody.input[systemMessageIndex].content = filePromptContent;
        } else {
          requestBody.input.unshift({
            type: "message",
            role: "developer",
            content: filePromptContent
          });
        }
      } else {
        requestBody.input = [ {
          type: "message",
          role: "developer",
          content: filePromptContent
        } ];
      }
    } else if (requestBody.instructions) {
      requestBody.instructions = filePromptContent;
    }
    logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'responses'.`);
    return requestBody;
  }
  async manageSystemPrompt(requestBody) {
    let incomingSystemText = "";
    if (requestBody.instructions) {
      incomingSystemText = requestBody.instructions;
    } else if (Array.isArray(requestBody.input)) {
      const systemMessage = requestBody.input.find(item => item.role === "developer" || item.type && item.type === "developer");
      if (systemMessage && systemMessage.content) {
        incomingSystemText = systemMessage.content;
      }
    }
    await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
  }
}

export { CodexResponsesAPIStrategy };