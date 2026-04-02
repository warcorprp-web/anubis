import logger from "./logger.js";

let countTokensFunc = null;

async function getCountTokens() {
  if (!countTokensFunc) {
    try {
      const module = await import("@anthropic-ai/tokenizer");
      countTokensFunc = module.countTokens;
    } catch (error) {
      logger.warn("[Token Utils] Failed to load @anthropic-ai/tokenizer, using fallback");
      countTokensFunc = text => Math.ceil(text.length / 4);
    }
  }
  return countTokensFunc;
}

export function getContentText(message) {
  if (message == null) {
    return "";
  }
  if (Array.isArray(message)) {
    return message.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (part.type === "text" && part.text) return part.text;
        if (part.text) return part.text;
      }
      return "";
    }).join("");
  } else if (typeof message.content === "string") {
    return message.content;
  } else if (Array.isArray(message.content)) {
    return message.content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (part.type === "text" && part.text) return part.text;
        if (part.text) return part.text;
      }
      return "";
    }).join("");
  }
  return String(message.content || message);
}

export function processContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (part.type === "text") return part.text || "";
        if (part.type === "thinking") return part.thinking || part.text || "";
        if (part.type === "tool_result") return processContent(part.content);
        if (part.type === "tool_use" && part.input) return JSON.stringify(part.input);
        if (part.text) return part.text;
      }
      return "";
    }).join("");
  }
  return getContentText(content);
}

export async function countTextTokens(text) {
  if (!text) return 0;
  try {
    const countTokens = await getCountTokens();
    return countTokens(text);
  } catch (error) {
    logger.warn("[TokenUtils] Tokenizer error, falling back to estimation:", error.message);
    return Math.ceil((text || "").length / 4);
  }
}

export function estimateInputTokens(requestBody) {
  let allText = "";
  if (requestBody.system) {
    allText += processContent(requestBody.system);
  }
  if (requestBody.thinking?.type && typeof requestBody.thinking.type === "string") {
    const t = requestBody.thinking.type.toLowerCase().trim();
    if (t === "enabled") {
      const budgetTokens = requestBody.thinking.budget_tokens;
      let budget = Number(budgetTokens);
      if (!Number.isFinite(budget) || budget <= 0) {
        budget = 2e4;
      }
      budget = Math.floor(budget);
      if (budget < 1024) budget = 1024;
      budget = Math.min(budget, 24576);
      allText += `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
    } else if (t === "adaptive") {
      const effortRaw = typeof requestBody.thinking.effort === "string" ? requestBody.thinking.effort : "";
      const effort = effortRaw.toLowerCase().trim();
      const normalizedEffort = effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
      allText += `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
    }
  }
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      if (message.content) {
        allText += processContent(message.content);
      }
    }
  }
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    allText += JSON.stringify(requestBody.tools);
  }
  return countTextTokens(allText);
}

export async function countTokensAnthropic(requestBody) {
  let allText = "";
  let extraTokens = 0;
  if (requestBody.system) {
    allText += processContent(requestBody.system);
  }
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      if (message.content) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "image") {
              extraTokens += 1600;
            } else if (block.type === "document") {
              if (block.source?.data) {
                const estimatedChars = block.source.data.length * .75;
                extraTokens += Math.ceil(estimatedChars / 4);
              }
            } else {
              allText += processContent([ block ]);
            }
          }
        } else {
          allText += processContent(message.content);
        }
      }
    }
  }
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    allText += JSON.stringify(requestBody.tools);
  }
  return {
    input_tokens: await countTextTokens(allText) + extraTokens
  };
}