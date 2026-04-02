import { validateKey, incrementUsage, KEY_PREFIX } from "./key-manager.js";

import logger from "../../utils/logger.js";

export function extractPotluckKey(req, requestUrl) {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token.startsWith(KEY_PREFIX)) {
      return token;
    }
  }
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
    return xApiKey;
  }
  const googApiKey = req.headers["x-goog-api-key"];
  if (googApiKey && googApiKey.startsWith(KEY_PREFIX)) {
    return googApiKey;
  }
  const queryKey = requestUrl.searchParams.get("key");
  if (queryKey && queryKey.startsWith(KEY_PREFIX)) {
    return queryKey;
  }
  return null;
}

export function isPotluckRequest(req, requestUrl) {
  return extractPotluckKey(req, requestUrl) !== null;
}

export async function potluckAuthMiddleware(req, requestUrl) {
  const apiKey = extractPotluckKey(req, requestUrl);
  if (!apiKey) {
    return {
      authorized: null
    };
  }
  const validation = await validateKey(apiKey);
  if (!validation.valid) {
    const errorMessages = {
      invalid_format: "Invalid API key format",
      not_found: "API key not found",
      disabled: "API key has been disabled",
      quota_exceeded: "Quota exceeded for this API key"
    };
    const statusCodes = {
      invalid_format: 401,
      not_found: 401,
      disabled: 403,
      quota_exceeded: 429
    };
    return {
      authorized: false,
      error: {
        statusCode: statusCodes[validation.reason] || 401,
        message: errorMessages[validation.reason] || "Authentication failed",
        code: validation.reason,
        keyData: validation.keyData
      }
    };
  }
  return {
    authorized: true,
    keyData: validation.keyData,
    apiKey: apiKey
  };
}

export async function recordPotluckUsage(apiKey) {
  if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
    return null;
  }
  return incrementUsage(apiKey);
}

export function sendPotluckError(res, error) {
  const response = {
    error: {
      message: error.message,
      code: error.code,
      type: "potluck_error"
    }
  };
  if (error.code === "quota_exceeded" && error.keyData) {
    response.error.quota = {
      used: error.keyData.todayUsage,
      limit: error.keyData.dailyLimit,
      resetDate: error.keyData.lastResetDate
    };
  }
  if (res.writableEnded || res.destroyed) {
    logger.warn("[API Potluck] Response already ended, skipping error response");
    return;
  }
  if (!res.headersSent) {
    res.writeHead(error.statusCode, {
      "Content-Type": "application/json"
    });
  }
  try {
    res.end(JSON.stringify(response));
  } catch (writeError) {
    logger.error("[API Potluck] Failed to write error response:", writeError.message);
  }
}