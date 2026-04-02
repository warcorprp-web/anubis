import { ProviderStrategy } from "../../utils/provider-strategy.js";

class ForwardStrategy extends ProviderStrategy {
  extractModelAndStreamInfo(req, requestBody) {
    const model = requestBody.model || "default";
    const isStream = requestBody.stream === true;
    return {
      model: model,
      isStream: isStream
    };
  }
  extractResponseText(response) {
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      if (choice.message && choice.message.content) {
        return choice.message.content;
      } else if (choice.delta && choice.delta.content) {
        return choice.delta.content;
      }
    }
    if (response.content && Array.isArray(response.content)) {
      return response.content.map(c => c.text || "").join("");
    }
    return "";
  }
  extractPromptText(requestBody) {
    if (requestBody.messages && requestBody.messages.length > 0) {
      const lastMessage = requestBody.messages[requestBody.messages.length - 1];
      let content = lastMessage.content;
      if (typeof content === "object" && content !== null) {
        return JSON.stringify(content);
      }
      return content;
    }
    return "";
  }
  async applySystemPromptFromFile(config, requestBody) {
    return requestBody;
  }
  async manageSystemPrompt(requestBody) {}
}

export { ForwardStrategy };