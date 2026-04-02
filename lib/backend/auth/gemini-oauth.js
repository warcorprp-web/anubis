import { OAuth2Client } from "google-auth-library";

import logger from "../utils/logger.js";

import http from "http";

import fs from "fs";

import path from "path";

import os from "os";

import { broadcastEvent } from "../services/ui-adapter";

import { autoLinkProviderConfigs } from "../services/service-adapter";

import { CONFIG } from "../core/config-adapter";

import { getGoogleAuthProxyConfig } from "../services/service-adapter";

const OAUTH_PROVIDERS = {
  "gemini-cli-oauth": {
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    port: 8085,
    credentialsDir: ".gemini",
    credentialsFile: "oauth_creds.json",
    scope: [ "https://www.googleapis.com/auth/cloud-platform" ],
    logPrefix: "[Gemini Auth]"
  },
  "gemini-antigravity": {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    port: 8086,
    credentialsDir: ".antigravity",
    credentialsFile: "oauth_creds.json",
    scope: [ "https://www.googleapis.com/auth/cloud-platform" ],
    logPrefix: "[Antigravity Auth]"
  }
};

const activeServers = new Map;

function generateResponsePage(isSuccess, message, provider = null) {
  const title = isSuccess ? "授权成功！" : "授权失败";
  const countdownHtml = isSuccess ? `\n        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>\n        <script>\n            const notifyOpener = () => {\n                try {\n                    if (window.opener && !window.opener.closed) {\n                        window.opener.postMessage({\n                            type: 'oauth-popup-complete',\n                            provider: ${JSON.stringify(provider)},\n                            success: true\n                        }, window.location.origin);\n                    }\n                } catch (e) {}\n            };\n            notifyOpener();\n            setTimeout(() => {\n                try {\n                    window.close();\n                } catch (e) {}\n            }, 300);\n            let countdown = 10;\n            const timer = setInterval(() => {\n                countdown--;\n                const el = document.getElementById('countdown');\n                if (el) el.textContent = countdown;\n                if (countdown <= 0) {\n                    clearInterval(timer);\n                    window.close();\n                }\n            }, 1000);\n        <\/script>` : "";
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>${title}</title>\n    <style>\n        body {\n            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            height: 100vh;\n            margin: 0;\n            background-color: #f5f5f5;\n        }\n        .container {\n            text-align: center;\n            padding: 2rem;\n            background: white;\n            border-radius: 8px;\n            box-shadow: 0 2px 10px rgba(0,0,0,0.1);\n            max-width: 400px;\n            width: 90%;\n        }\n        h1 { color: ${isSuccess ? "#4caf50" : "#f44336"}; margin-top: 0; }\n        p { color: #666; line-height: 1.6; }\n    </style>\n</head>\n<body>\n    <div class="container">\n        <h1>${isSuccess ? "✅" : "❌"} ${title}</h1>\n        <p>${message}</p>\n        ${countdownHtml}\n    </div>\n</body>\n</html>`;
}

async function closeActiveServer(provider, port = null) {
  const existing = activeServers.get(provider);
  if (existing) {
    if (existing.pollTimer) {
      clearInterval(existing.pollTimer);
      existing.pollTimer = null;
    }
    try {
      if (existing.server.closeAllConnections) {
        existing.server.closeAllConnections();
      }
      const closePromise = new Promise((resolve, reject) => {
        existing.server.close(err => {
          if (err) reject(err); else resolve();
        });
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Server close timeout after 2s")), 2e3);
      });
      await Promise.race([ closePromise, timeoutPromise ]);
      logger.info(`[OAuth] 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
    } catch (error) {
      logger.warn(`[OAuth] 关闭提供商 ${provider} 服务器失败或超时: ${error.message}`);
    } finally {
      activeServers.delete(provider);
    }
  }
  if (port) {
    for (const [p, info] of activeServers.entries()) {
      if (info.port === port) {
        await closeActiveServer(p);
      }
    }
  }
}

async function createOAuthCallbackServer(config, redirectUri, authClient, credPath, provider, options = {}) {
  const port = parseInt(options.port) || config.port;
  await closeActiveServer(provider, port);
  return new Promise((resolve, reject) => {
    let pollCount = 0;
    const maxPollCount = 100;
    const pollInterval = 3e3;
    let pollTimer = null;
    const clearPollTimer = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        const code = url.searchParams.get("code");
        const errorParam = url.searchParams.get("error");
        if (code) {
          clearPollTimer();
          logger.info(`${config.logPrefix} 收到来自 Google 的成功回调: ${req.url}`);
          try {
            const {tokens: tokens} = await authClient.getToken(code);
            let finalCredPath = credPath;
            if (options.saveToConfigs) {
              const providerDir = options.providerDir;
              const targetDir = path.join(process.cwd(), "configs", providerDir);
              await fs.promises.mkdir(targetDir, {
                recursive: true
              });
              const timestamp = Date.now();
              const filename = `${timestamp}_oauth_creds.json`;
              finalCredPath = path.join(targetDir, filename);
            }
            await fs.promises.mkdir(path.dirname(finalCredPath), {
              recursive: true
            });
            await fs.promises.writeFile(finalCredPath, JSON.stringify(tokens, null, 2));
            logger.info(`${config.logPrefix} 新令牌已接收并保存到文件: ${finalCredPath}`);
            const relativePath = path.relative(process.cwd(), finalCredPath);
            broadcastEvent("oauth_success", {
              provider: provider,
              credPath: finalCredPath,
              relativePath: relativePath,
              timestamp: (new Date).toISOString()
            });
            await autoLinkProviderConfigs(CONFIG, {
              onlyCurrentCred: true,
              credPath: relativePath
            });
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(true, "您可以关闭此页面", provider));
          } catch (tokenError) {
            logger.error(`${config.logPrefix} 获取令牌失败:`, tokenError);
            broadcastEvent("oauth_error", {
              provider: provider,
              error: tokenError.message,
              timestamp: (new Date).toISOString()
            });
            res.writeHead(500, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, `获取令牌失败: ${tokenError.message}`, provider));
          } finally {
            server.close(() => {
              activeServers.delete(provider);
            });
          }
        } else if (errorParam) {
          clearPollTimer();
          const errorMessage = `授权失败。Google 返回错误: ${errorParam}`;
          logger.error(`${config.logPrefix}`, errorMessage);
          broadcastEvent("oauth_error", {
            provider: provider,
            error: errorMessage,
            timestamp: (new Date).toISOString()
          });
          res.writeHead(400, {
            "Content-Type": "text/html; charset=utf-8"
          });
          res.end(generateResponsePage(false, errorMessage, provider));
          server.close(() => {
            activeServers.delete(provider);
          });
        } else {
          logger.info(`${config.logPrefix} 忽略无关请求: ${req.url}`);
          res.writeHead(204);
          res.end();
        }
      } catch (error) {
        clearPollTimer();
        logger.error(`${config.logPrefix} 处理回调时出错:`, error);
        res.writeHead(500, {
          "Content-Type": "text/html; charset=utf-8"
        });
        res.end(generateResponsePage(false, `服务器错误: ${error.message}`, provider));
        if (server.listening) {
          server.close(() => {
            activeServers.delete(provider);
          });
        }
      }
    });
    server.on("error", err => {
      clearPollTimer();
      if (err.code === "EADDRINUSE") {
        logger.error(`${config.logPrefix} 端口 ${port} 已被占用`);
        reject(new Error(`端口 ${port} 已被占用`));
      } else {
        logger.error(`${config.logPrefix} 服务器错误:`, err);
        reject(err);
      }
    });
    const host = "0.0.0.0";
    server.listen(port, host, () => {
      logger.info(`${config.logPrefix} OAuth 回调服务器已启动于 ${host}:${port}`);
      pollTimer = setInterval(() => {
        pollCount++;
        if (pollCount <= maxPollCount) {
          logger.info(`${config.logPrefix} Waiting for callback... (${pollCount}/${maxPollCount})`);
        } else {
          clearPollTimer();
          logger.warn(`${config.logPrefix} Polling timeout, closing server...`);
          if (server.listening) {
            server.close(() => {
              activeServers.delete(provider);
            });
          }
        }
      }, pollInterval);
      activeServers.set(provider, {
        server: server,
        port: port,
        pollTimer: pollTimer
      });
      resolve(server);
    });
  });
}

async function handleGoogleOAuth(providerKey, currentConfig, options = {}) {
  const config = OAUTH_PROVIDERS[providerKey];
  if (!config) {
    throw new Error(`未知的提供商: ${providerKey}`);
  }
  const port = parseInt(options.port) || config.port;
  const host = "localhost";
  const redirectUri = `http://${host}:${port}`;
  const proxyConfig = getGoogleAuthProxyConfig(currentConfig, providerKey);
  const oauth2Options = {
    clientId: config.clientId,
    clientSecret: config.clientSecret
  };
  if (proxyConfig) {
    oauth2Options.transporterOptions = proxyConfig;
    logger.info(`${config.logPrefix} Using proxy for OAuth token exchange`);
  }
  const authClient = new OAuth2Client(oauth2Options);
  authClient.redirectUri = redirectUri;
  const authUrl = authClient.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: config.scope
  });
  const credPath = path.join(os.homedir(), config.credentialsDir, config.credentialsFile);
  try {
    await createOAuthCallbackServer(config, redirectUri, authClient, credPath, providerKey, options);
  } catch (error) {
    throw new Error(`启动回调服务器失败: ${error.message}`);
  }
  return {
    authUrl: authUrl,
    authInfo: {
      provider: providerKey,
      redirectUri: redirectUri,
      port: port,
      ...options
    }
  };
}

export async function handleGeminiCliOAuth(currentConfig, options = {}) {
  return handleGoogleOAuth("gemini-cli-oauth", currentConfig, options);
}

export async function handleGeminiAntigravityOAuth(currentConfig, options = {}) {
  return handleGoogleOAuth("gemini-antigravity", currentConfig, options);
}

export async function checkGeminiCredentialsDuplicate(providerType, refreshToken) {
  const config = OAUTH_PROVIDERS[providerType];
  if (!config) return {
    isDuplicate: false
  };
  const providerDir = config.credentialsDir.replace(".", "");
  const targetDir = path.join(process.cwd(), "configs", providerDir);
  try {
    if (!fs.existsSync(targetDir)) {
      return {
        isDuplicate: false
      };
    }
    const files = await fs.promises.readdir(targetDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const fullPath = path.join(targetDir, file);
          const content = await fs.promises.readFile(fullPath, "utf8");
          const credentials = JSON.parse(content);
          if (credentials.refresh_token === refreshToken) {
            const relativePath = path.relative(process.cwd(), fullPath);
            return {
              isDuplicate: true,
              existingPath: relativePath
            };
          }
        } catch (e) {}
      }
    }
    return {
      isDuplicate: false
    };
  } catch (error) {
    logger.warn(`[Gemini Auth] Error checking duplicates for ${providerType}:`, error.message);
    return {
      isDuplicate: false
    };
  }
}

export async function batchImportGeminiTokensStream(providerType, tokens, onProgress = null, skipDuplicateCheck = false) {
  const config = OAUTH_PROVIDERS[providerType];
  if (!config) {
    throw new Error(`未知的提供商: ${providerType}`);
  }
  const results = {
    total: tokens.length,
    success: 0,
    failed: 0,
    details: []
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const progressData = {
      index: i + 1,
      total: tokens.length,
      current: null
    };
    try {
      if (!token.access_token || !token.refresh_token) {
        throw new Error("Token 缺少必需字段 (access_token 或 refresh_token)");
      }
      if (!skipDuplicateCheck) {
        const duplicateCheck = await checkGeminiCredentialsDuplicate(providerType, token.refresh_token);
        if (duplicateCheck.isDuplicate) {
          progressData.current = {
            index: i + 1,
            success: false,
            error: "duplicate",
            existingPath: duplicateCheck.existingPath
          };
          results.failed++;
          results.details.push(progressData.current);
          if (onProgress) {
            onProgress({
              ...progressData,
              successCount: results.success,
              failedCount: results.failed
            });
          }
          continue;
        }
      }
      const timestamp = Date.now();
      const providerDir = config.credentialsDir.replace(".", "");
      const targetDir = path.join(process.cwd(), "configs", providerDir);
      await fs.promises.mkdir(targetDir, {
        recursive: true
      });
      const filename = `${timestamp}_${i}_oauth_creds.json`;
      const credPath = path.join(targetDir, filename);
      await fs.promises.writeFile(credPath, JSON.stringify(token, null, 2));
      const relativePath = path.relative(process.cwd(), credPath);
      logger.info(`${config.logPrefix} Token ${i + 1} 已导入并保存: ${relativePath}`);
      progressData.current = {
        index: i + 1,
        success: true,
        path: relativePath
      };
      results.success++;
      await autoLinkProviderConfigs(CONFIG, {
        onlyCurrentCred: true,
        credPath: relativePath
      });
    } catch (error) {
      logger.error(`${config.logPrefix} Token ${i + 1} 导入失败:`, error.message);
      progressData.current = {
        index: i + 1,
        success: false,
        error: error.message
      };
      results.failed++;
    }
    results.details.push(progressData.current);
    if (onProgress) {
      onProgress({
        ...progressData,
        successCount: results.success,
        failedCount: results.failed
      });
    }
  }
  if (results.success > 0) {
    broadcastEvent("oauth_batch_success", {
      provider: providerType,
      count: results.success,
      timestamp: (new Date).toISOString()
    });
  }
  return results;
}