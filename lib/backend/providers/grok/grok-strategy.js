import { API_ACTIONS, MODEL_PROTOCOL_PREFIX } from "../../utils/common.js";

import logger from "../../utils/logger.js";

import { ProviderStrategy } from "../../utils/provider-strategy.js";

class GrokStrategy extends ProviderStrategy {
  extractModelAndStreamInfo(req, requestBody) {
    const model = requestBody.model || "grok-3";
    const isStream = requestBody.stream !== false;
    return {
      model: model,
      isStream: isStream
    };
  }
  extractResponseText(response) {
    return response.message || "";
  }
  extractPromptText(requestBody) {
    return requestBody.message || "";
  }
  async applySystemPromptFromFile(config, requestBody) {
    if (!config.SYSTEM_PROMPT_FILE_PATH) {
      return requestBody;
    }
    const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
    if (filePromptContent === null) {
      return requestBody;
    }
    const existingMessage = requestBody.message || "";
    const newSystemText = config.SYSTEM_PROMPT_MODE === "append" ? `${existingMessage}\n\nSystem: ${filePromptContent}` : `System: ${filePromptContent}\n\n${existingMessage}`;
    requestBody.message = newSystemText;
    logger.info(`[System Prompt] Applied system prompt for Grok in '${config.SYSTEM_PROMPT_MODE}' mode.`);
    return requestBody;
  }
  async manageSystemPrompt(requestBody) {}
}

export { GrokStrategy };