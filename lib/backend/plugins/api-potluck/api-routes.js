import { createKey, listKeys, getKey, deleteKey, updateKeyLimit, resetKeyUsage, toggleKey, updateKeyName, regenerateKey, getStats, validateKey, KEY_PREFIX, applyDailyLimitToAllKeys, getAllKeyIds } from "./key-manager.js";

import logger from "../../utils/logger.js";

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(data));
}

async function checkAdminAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  try {
    const {existsSync: existsSync, readFileSync: readFileSync} = await import("fs");
    const {promises: fs} = await import("fs");
    const path = await import("path");
    const TOKEN_STORE_FILE = path.join(process.cwd(), "configs", "token-store.json");
    if (!existsSync(TOKEN_STORE_FILE)) {
      return false;
    }
    const content = readFileSync(TOKEN_STORE_FILE, "utf8");
    const tokenStore = JSON.parse(content);
    const token = authHeader.substring(7);
    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo) {
      return false;
    }
    if (Date.now() > tokenInfo.expiryTime) {
      return false;
    }
    return true;
  } catch (error) {
    logger.error("[API Potluck] Auth check error:", error.message);
    return false;
  }
}

export async function handlePotluckApiRoutes(method, path, req, res) {
  if (!path.startsWith("/api/potluck")) {
    return false;
  }
  logger.info("[API Potluck] Handling request:", method, path);
  const isAuthed = await checkAdminAuth(req);
  if (!isAuthed) {
    sendJson(res, 401, {
      success: false,
      error: {
        message: "未授权：请先登录",
        code: "UNAUTHORIZED"
      }
    });
    return true;
  }
  try {
    if (method === "GET" && path === "/api/potluck/stats") {
      const stats = await getStats();
      sendJson(res, 200, {
        success: true,
        data: stats
      });
      return true;
    }
    if (method === "GET" && path === "/api/potluck/keys") {
      const keys = await listKeys();
      const stats = await getStats();
      sendJson(res, 200, {
        success: true,
        data: {
          keys: keys,
          stats: stats
        }
      });
      return true;
    }
    if (method === "POST" && path === "/api/potluck/keys/apply-limit") {
      const body = await parseRequestBody(req);
      const {dailyLimit: dailyLimit} = body;
      if (dailyLimit === undefined || typeof dailyLimit !== "number" || dailyLimit < 1) {
        sendJson(res, 400, {
          success: false,
          error: {
            message: "dailyLimit 必须是一个正数"
          }
        });
        return true;
      }
      const result = await applyDailyLimitToAllKeys(dailyLimit);
      sendJson(res, 200, {
        success: true,
        message: `已将每日限额 ${dailyLimit} 应用到 ${result.updated}/${result.total} 个 Key`,
        data: result
      });
      return true;
    }
    if (method === "POST" && path === "/api/potluck/keys") {
      const body = await parseRequestBody(req);
      const {name: name, dailyLimit: dailyLimit} = body;
      const keyData = await createKey(name, dailyLimit);
      sendJson(res, 201, {
        success: true,
        message: "API Key 创建成功",
        data: keyData
      });
      return true;
    }
    const keyIdMatch = path.match(/^\/api\/potluck\/keys\/([^\/]+)(\/.*)?$/);
    if (keyIdMatch) {
      const keyId = decodeURIComponent(keyIdMatch[1]);
      const subPath = keyIdMatch[2] || "";
      if (method === "GET" && !subPath) {
        const keyData = await getKey(keyId);
        if (!keyData) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          data: keyData
        });
        return true;
      }
      if (method === "DELETE" && !subPath) {
        const deleted = await deleteKey(keyId);
        if (!deleted) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: "Key 删除成功"
        });
        return true;
      }
      if (method === "PUT" && subPath === "/limit") {
        const body = await parseRequestBody(req);
        const {dailyLimit: dailyLimit} = body;
        if (typeof dailyLimit !== "number" || dailyLimit < 0) {
          sendJson(res, 400, {
            success: false,
            error: {
              message: "无效的每日限额值"
            }
          });
          return true;
        }
        const keyData = await updateKeyLimit(keyId, dailyLimit);
        if (!keyData) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: "每日限额更新成功",
          data: keyData
        });
        return true;
      }
      if (method === "POST" && subPath === "/reset") {
        const keyData = await resetKeyUsage(keyId);
        if (!keyData) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: "使用量重置成功",
          data: keyData
        });
        return true;
      }
      if (method === "POST" && subPath === "/toggle") {
        const keyData = await toggleKey(keyId);
        if (!keyData) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: `Key 已成功${keyData.enabled ? "启用" : "禁用"}`,
          data: keyData
        });
        return true;
      }
      if (method === "PUT" && subPath === "/name") {
        const body = await parseRequestBody(req);
        const {name: name} = body;
        if (!name || typeof name !== "string") {
          sendJson(res, 400, {
            success: false,
            error: {
              message: "无效的名称值"
            }
          });
          return true;
        }
        const keyData = await updateKeyName(keyId, name);
        if (!keyData) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: "名称更新成功",
          data: keyData
        });
        return true;
      }
      if (method === "POST" && subPath === "/regenerate") {
        const result = await regenerateKey(keyId);
        if (!result) {
          sendJson(res, 404, {
            success: false,
            error: {
              message: "未找到 Key"
            }
          });
          return true;
        }
        sendJson(res, 200, {
          success: true,
          message: "Key 重新生成成功",
          data: {
            oldKey: result.oldKey,
            newKey: result.newKey,
            keyData: result.keyData
          }
        });
        return true;
      }
    }
    sendJson(res, 404, {
      success: false,
      error: {
        message: "未找到 Potluck API 端点"
      }
    });
    return true;
  } catch (error) {
    logger.error("[API Potluck] API error:", error);
    sendJson(res, 500, {
      success: false,
      error: {
        message: error.message || "内部服务器错误"
      }
    });
    return true;
  }
}

function extractApiKeyFromRequest(req) {
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
  return null;
}

export async function handlePotluckUserApiRoutes(method, path, req, res) {
  if (!path.startsWith("/api/potluckuser")) {
    return false;
  }
  logger.info("[API Potluck User] Handling request:", method, path);
  try {
    const apiKey = extractApiKeyFromRequest(req);
    if (!apiKey) {
      sendJson(res, 401, {
        success: false,
        error: {
          message: "需要 API Key。请在 Authorization 标头 (Bearer maki_xxx) 或 x-api-key 标头中提供您的 API Key。",
          code: "API_KEY_REQUIRED"
        }
      });
      return true;
    }
    const validation = await validateKey(apiKey);
    if (!validation.valid && validation.reason !== "quota_exceeded") {
      const errorMessages = {
        invalid_format: "API Key 格式无效",
        not_found: "未找到 API Key",
        disabled: "API Key 已禁用"
      };
      sendJson(res, 401, {
        success: false,
        error: {
          message: errorMessages[validation.reason] || "无效的 API Key",
          code: validation.reason
        }
      });
      return true;
    }
    if (method === "GET" && path === "/api/potluckuser/usage") {
      const keyData = await getKey(apiKey);
      if (!keyData) {
        sendJson(res, 404, {
          success: false,
          error: {
            message: "未找到 Key",
            code: "KEY_NOT_FOUND"
          }
        });
        return true;
      }
      const usagePercent = keyData.dailyLimit > 0 ? Math.round(keyData.todayUsage / keyData.dailyLimit * 100) : 0;
      sendJson(res, 200, {
        success: true,
        data: {
          name: keyData.name,
          enabled: keyData.enabled,
          usage: {
            today: keyData.todayUsage,
            limit: keyData.dailyLimit,
            remaining: Math.max(0, keyData.dailyLimit - keyData.todayUsage),
            percent: usagePercent,
            resetDate: keyData.lastResetDate
          },
          total: keyData.totalUsage,
          lastUsedAt: keyData.lastUsedAt,
          createdAt: keyData.createdAt,
          usageHistory: keyData.usageHistory || {},
          maskedKey: `${apiKey.substring(0, 12)}...${apiKey.substring(apiKey.length - 4)}`
        }
      });
      return true;
    }
    sendJson(res, 404, {
      success: false,
      error: {
        message: "未找到用户 API 端点"
      }
    });
    return true;
  } catch (error) {
    logger.error("[API Potluck] User API error:", error);
    sendJson(res, 500, {
      success: false,
      error: {
        message: error.message || "内部服务器错误"
      }
    });
    return true;
  }
}