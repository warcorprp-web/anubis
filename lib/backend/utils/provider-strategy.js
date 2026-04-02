import { promises as fs } from "fs";

import logger from "./logger.js";

import { FETCH_SYSTEM_PROMPT_FILE } from "../utils/common.js";

export class ProviderStrategy {
  extractModelAndStreamInfo(req, requestBody) {
    throw new Error("Method 'extractModelAndStreamInfo()' must be implemented.");
  }
  extractResponseText(response) {
    throw new Error("Method 'extractResponseText()' must be implemented.");
  }
  extractPromptText(requestBody) {
    throw new Error("Method 'extractPromptText()' must be implemented.");
  }
  async applySystemPromptFromFile(config, requestBody) {
    throw new Error("Method 'applySystemPromptFromFile()' must be implemented.");
  }
  async manageSystemPrompt(requestBody) {
    throw new Error("Method 'manageSystemPrompt()' must be implemented.");
  }
  async _updateSystemPromptFile(incomingSystemText, providerName) {
    let currentSystemText = "";
    try {
      currentSystemText = await fs.readFile(FETCH_SYSTEM_PROMPT_FILE, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error(`[System Prompt Manager] Error reading system prompt file: ${error.message}`);
      }
    }
    try {
      if (incomingSystemText && incomingSystemText !== currentSystemText) {
        await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, incomingSystemText);
        logger.info(`[System Prompt Manager] System prompt updated in file for provider '${providerName}'.`);
      } else if (!incomingSystemText && currentSystemText) {
        await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, "");
        logger.info("[System Prompt Manager] System prompt cleared from file.");
      }
    } catch (error) {
      logger.error(`[System Prompt Manager] Failed to manage system prompt file: ${error.message}`);
    }
  }
}