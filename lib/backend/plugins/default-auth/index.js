import logger from "../../utils/logger.js";

function isAuthorized(req, requestUrl, requiredApiKey) {
  const authHeader = req.headers["authorization"];
  const queryKey = requestUrl.searchParams.get("key");
  const googApiKey = req.headers["x-goog-api-key"];
  const claudeApiKey = req.headers["x-api-key"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token === requiredApiKey) {
      return true;
    }
  }
  if (queryKey === requiredApiKey) {
    return true;
  }
  if (googApiKey === requiredApiKey) {
    return true;
  }
  if (claudeApiKey === requiredApiKey) {
    return true;
  }
  return false;
}

const defaultAuthPlugin = {
  name: "default-auth",
  version: "1.0.0",
  description: "默认 API Key 认证插件",
  type: "auth",
  _builtin: true,
  _priority: 9999,
  async authenticate(req, res, requestUrl, config) {
    if (isAuthorized(req, requestUrl, config.REQUIRED_API_KEY)) {
      return {
        handled: false,
        authorized: true
      };
    }
    logger.info(`[Default Auth] Unauthorized request. Headers: Authorization=${req.headers["authorization"] ? "present" : "N/A"}, x-api-key=${req.headers["x-api-key"] || "N/A"}, x-goog-api-key=${req.headers["x-goog-api-key"] || "N/A"}`);
    return {
      handled: false,
      authorized: null
    };
  }
};

export default defaultAuthPlugin;