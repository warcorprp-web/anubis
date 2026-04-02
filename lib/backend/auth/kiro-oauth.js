import http from "http";

import logger from "../utils/logger.js";

import fs from "fs";

import path from "path";

import crypto from "crypto";

import os from "os";

import { broadcastEvent } from "../services/ui-adapter";

import { autoLinkProviderConfigs } from "../services/service-adapter";

import { CONFIG } from "../core/config-adapter";

import { getProxyConfigForProvider } from "../services/service-adapter";

const KIRO_OAUTH_CONFIG = {
  authServiceEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
  ssoOIDCEndpoint: "https://oidc.{{region}}.amazonaws.com",
  builderIDStartURL: "https://view.awsapps.com/start",
  callbackPortStart: 19876,
  callbackPortEnd: 19880,
  authTimeout: 10 * 60 * 1e3,
  pollInterval: 5e3,
  scopes: [ "codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations" ],
  credentialsDir: ".kiro",
  credentialsFile: "oauth_creds.json",
  logPrefix: "[Kiro Auth]"
};

const activeKiroServers = new Map;

const activeKiroPollingTasks = new Map;

async function fetchWithProxy(url, options = {}, providerType) {
  const proxyConfig = getProxyConfigForProvider(CONFIG, providerType);
  const axiosConfig = {
    url: url,
    method: options.method || "GET",
    headers: options.headers || {},
    timeout: 3e4
  };
  if (options.body) {
    axiosConfig.data = options.body;
  }
  if (proxyConfig) {
    axiosConfig.httpAgent = proxyConfig.httpAgent;
    axiosConfig.httpsAgent = proxyConfig.httpsAgent;
    axiosConfig.proxy = false;
    logger.info(`[OAuth] Using proxy for ${providerType}: ${CONFIG.PROXY_URL}`);
  }
  try {
    const axios = (await import("axios")).default;
    const response = await axios(axiosConfig);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      json: async () => response.data,
      text: async () => typeof response.data === "string" ? response.data : JSON.stringify(response.data)
    };
  } catch (error) {
    if (error.response) {
      return {
        ok: false,
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
        json: async () => error.response.data,
        text: async () => typeof error.response.data === "string" ? error.response.data : JSON.stringify(error.response.data)
      };
    }
    throw error;
  }
}

function generateResponsePage(isSuccess, message) {
  const title = isSuccess ? "授权成功！" : "授权失败";
  const countdownHtml = isSuccess ? `\n        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>\n        <script>\n            let countdown = 10;\n            const timer = setInterval(() => {\n                countdown--;\n                const el = document.getElementById('countdown');\n                if (el) el.textContent = countdown;\n                if (countdown <= 0) {\n                    clearInterval(timer);\n                    window.close();\n                }\n            }, 1000);\n        <\/script>` : "";
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>${title}</title>\n    <style>\n        body {\n            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            height: 100vh;\n            margin: 0;\n            background-color: #f5f5f5;\n        }\n        .container {\n            text-align: center;\n            padding: 2rem;\n            background: white;\n            border-radius: 8px;\n            box-shadow: 0 2px 10px rgba(0,0,0,0.1);\n            max-width: 400px;\n            width: 90%;\n        }\n        h1 { color: ${isSuccess ? "#4caf50" : "#f44336"}; margin-top: 0; }\n        p { color: #666; line-height: 1.6; }\n    </style>\n</head>\n<body>\n    <div class="container">\n        <h1>${isSuccess ? "✅" : "❌"} ${title}</h1>\n        <p>${message}</p>\n        ${countdownHtml}\n    </div>\n</body>\n</html>`;
}

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash("sha256");
  hash.update(codeVerifier);
  return hash.digest("base64url");
}

export async function handleKiroOAuth(currentConfig, options = {}) {
  const method = options.method || options.authMethod || "google";
  logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Starting OAuth with method: ${method}`);
  switch (method) {
   case "google":
    return handleKiroSocialAuth("Google", currentConfig, options);

   case "github":
    return handleKiroSocialAuth("Github", currentConfig, options);

   case "builder-id":
    return handleKiroBuilderIDDeviceCode(currentConfig, options);

   default:
    throw new Error(`不支持的认证方式: ${method}`);
  }
}

async function handleKiroSocialAuth(provider, currentConfig, options = {}) {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString("base64url");
  let handlerPort;
  const providerKey = "claude-kiro-oauth";
  if (options.port) {
    const port = parseInt(options.port);
    await closeKiroServer(providerKey, port);
    const server = await createKiroHttpCallbackServer(port, codeVerifier, state, options);
    activeKiroServers.set(providerKey, {
      server: server,
      port: port
    });
    handlerPort = port;
  } else {
    handlerPort = await startKiroCallbackServer(codeVerifier, state, options);
  }
  const redirectUri = `http://127.0.0.1:${handlerPort}/oauth/callback`;
  const authUrl = `${KIRO_OAUTH_CONFIG.authServiceEndpoint}/login?` + `idp=${provider}&` + `redirect_uri=${encodeURIComponent(redirectUri)}&` + `code_challenge=${codeChallenge}&` + `code_challenge_method=S256&` + `state=${state}&` + `prompt=select_account`;
  return {
    authUrl: authUrl,
    authInfo: {
      provider: "claude-kiro-oauth",
      authMethod: "social",
      socialProvider: provider,
      port: handlerPort,
      redirectUri: redirectUri,
      state: state,
      ...options
    }
  };
}

async function handleKiroBuilderIDDeviceCode(currentConfig, options = {}) {
  for (const [existingTaskId] of activeKiroPollingTasks.entries()) {
    if (existingTaskId.startsWith("kiro-")) {
      stopKiroPollingTask(existingTaskId);
    }
  }
  const builderIDStartURL = options.builderIDStartURL || KIRO_OAUTH_CONFIG.builderIDStartURL;
  logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Using Builder ID Start URL: ${builderIDStartURL}`);
  const region = options.region || "us-east-1";
  const ssoOIDCEndpoint = KIRO_OAUTH_CONFIG.ssoOIDCEndpoint.replace("{{region}}", region);
  const regResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/client/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "KiroIDE"
    },
    body: JSON.stringify({
      clientName: "Kiro IDE",
      clientType: "public",
      scopes: KIRO_OAUTH_CONFIG.scopes
    })
  }, "claude-kiro-oauth");
  if (!regResponse.ok) {
    throw new Error(`Kiro OAuth 客户端注册失败: ${regResponse.status}`);
  }
  const regData = await regResponse.json();
  const authResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      clientId: regData.clientId,
      clientSecret: regData.clientSecret,
      startUrl: builderIDStartURL
    })
  }, "claude-kiro-oauth");
  if (!authResponse.ok) {
    throw new Error(`Kiro OAuth 设备授权失败: ${authResponse.status}`);
  }
  const deviceAuth = await authResponse.json();
  const taskId = `kiro-${deviceAuth.deviceCode.substring(0, 8)}-${Date.now()}`;
  pollKiroBuilderIDToken(regData.clientId, regData.clientSecret, deviceAuth.deviceCode, 5, 300, taskId, {
    ...options,
    region: region
  }).catch(error => {
    logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} 轮询失败 [${taskId}]:`, error);
    broadcastEvent("oauth_error", {
      provider: "claude-kiro-oauth",
      error: error.message,
      timestamp: (new Date).toISOString()
    });
  });
  return {
    authUrl: deviceAuth.verificationUriComplete,
    authInfo: {
      provider: "claude-kiro-oauth",
      authMethod: "builder-id",
      deviceCode: deviceAuth.deviceCode,
      userCode: deviceAuth.userCode,
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresIn: deviceAuth.expiresIn,
      interval: deviceAuth.interval,
      ...options
    }
  };
}

async function pollKiroBuilderIDToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options = {}) {
  let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
  const maxAttempts = Math.floor(expiresIn / interval);
  let attempts = 0;
  const taskControl = {
    shouldStop: false
  };
  activeKiroPollingTasks.set(taskId, taskControl);
  logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 开始轮询令牌 [${taskId}]`);
  const poll = async () => {
    if (taskControl.shouldStop) {
      throw new Error("轮询任务已被取消");
    }
    if (attempts >= maxAttempts) {
      activeKiroPollingTasks.delete(taskId);
      throw new Error("授权超时");
    }
    attempts++;
    try {
      const region = options.region || "us-east-1";
      const ssoOIDCEndpoint = KIRO_OAUTH_CONFIG.ssoOIDCEndpoint.replace("{{region}}", region);
      const response = await fetchWithProxy(`${ssoOIDCEndpoint}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "KiroIDE"
        },
        body: JSON.stringify({
          clientId: clientId,
          clientSecret: clientSecret,
          deviceCode: deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code"
        })
      }, "claude-kiro-oauth");
      const data = await response.json();
      if (response.ok && data.accessToken) {
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 成功获取令牌 [${taskId}]`);
        if (options.saveToConfigs) {
          const timestamp = Date.now();
          const folderName = `${timestamp}_kiro-auth-token`;
          const targetDir = path.join(process.cwd(), "configs", "kiro", folderName);
          await fs.promises.mkdir(targetDir, {
            recursive: true
          });
          credPath = path.join(targetDir, `${folderName}.json`);
        }
        const tokenData = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: new Date(Date.now() + data.expiresIn * 1e3).toISOString(),
          authMethod: "builder-id",
          clientId: clientId,
          clientSecret: clientSecret,
          idcRegion: options.region || "us-east-1"
        };
        await fs.promises.mkdir(path.dirname(credPath), {
          recursive: true
        });
        await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
        activeKiroPollingTasks.delete(taskId);
        broadcastEvent("oauth_success", {
          provider: "claude-kiro-oauth",
          credPath: credPath,
          relativePath: path.relative(process.cwd(), credPath),
          timestamp: (new Date).toISOString()
        });
        await autoLinkProviderConfigs(CONFIG, {
          onlyCurrentCred: true,
          credPath: path.relative(process.cwd(), credPath)
        });
        return tokenData;
      }
      if (data.error === "authorization_pending") {
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 等待用户授权 [${taskId}]... (${attempts}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, interval * 1e3));
        return poll();
      } else if (data.error === "slow_down") {
        await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1e3));
        return poll();
      } else {
        activeKiroPollingTasks.delete(taskId);
        throw new Error(`授权失败: ${data.error || "未知错误"}`);
      }
    } catch (error) {
      if (error.message.includes("授权") || error.message.includes("取消")) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, interval * 1e3));
      return poll();
    }
  };
  return poll();
}

function stopKiroPollingTask(taskId) {
  const task = activeKiroPollingTasks.get(taskId);
  if (task) {
    task.shouldStop = true;
    activeKiroPollingTasks.delete(taskId);
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
  }
}

async function startKiroCallbackServer(codeVerifier, expectedState, options = {}) {
  const portStart = KIRO_OAUTH_CONFIG.callbackPortStart;
  const portEnd = KIRO_OAUTH_CONFIG.callbackPortEnd;
  for (let port = portStart; port <= portEnd; port++) {
    await closeKiroServer(port);
    try {
      const server = await createKiroHttpCallbackServer(port, codeVerifier, expectedState, options);
      activeKiroServers.set("claude-kiro-oauth", {
        server: server,
        port: port
      });
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
      return port;
    } catch (err) {
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 端口 ${port} 被占用，尝试下一个...`);
    }
  }
  throw new Error("所有端口都被占用");
}

async function closeKiroServer(provider, port = null) {
  const existing = activeKiroServers.get(provider);
  if (existing) {
    try {
      const closePromise = new Promise((resolve, reject) => {
        existing.server.close(err => {
          if (err) reject(err); else resolve();
        });
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Server close timeout after 2s")), 2e3);
      });
      await Promise.race([ closePromise, timeoutPromise ]);
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
    } catch (error) {
      logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} 关闭提供商 ${provider} 服务器失败或超时: ${error.message}`);
    } finally {
      activeKiroServers.delete(provider);
    }
  }
  if (port) {
    for (const [p, info] of activeKiroServers.entries()) {
      if (info.port === port) {
        await closeKiroServer(p);
      }
    }
  }
}

function createKiroHttpCallbackServer(port, codeVerifier, expectedState, options = {}) {
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname === "/oauth/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const errorParam = url.searchParams.get("error");
          if (errorParam) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
            return;
          }
          if (state !== expectedState) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, "State 验证失败"));
            return;
          }
          const tokenResponse = await fetchWithProxy(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "AIClient-2-API/1.0.0"
            },
            body: JSON.stringify({
              code: code,
              code_verifier: codeVerifier,
              redirect_uri: redirectUri
            })
          }, "claude-kiro-oauth");
          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token exchange failed:`, errorText);
            res.writeHead(500, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, `获取令牌失败: ${tokenResponse.status}`));
            return;
          }
          const tokenData = await tokenResponse.json();
          let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
          if (options.saveToConfigs) {
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            const targetDir = path.join(process.cwd(), "configs", "kiro", folderName);
            await fs.promises.mkdir(targetDir, {
              recursive: true
            });
            credPath = path.join(targetDir, `${folderName}.json`);
          }
          const saveData = {
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            profileArn: tokenData.profileArn,
            expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1e3).toISOString(),
            authMethod: "social",
            region: "us-east-1"
          };
          await fs.promises.mkdir(path.dirname(credPath), {
            recursive: true
          });
          await fs.promises.writeFile(credPath, JSON.stringify(saveData, null, 2));
          logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 令牌已保存: ${credPath}`);
          broadcastEvent("oauth_success", {
            provider: "claude-kiro-oauth",
            credPath: credPath,
            relativePath: path.relative(process.cwd(), credPath),
            timestamp: (new Date).toISOString()
          });
          await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: path.relative(process.cwd(), credPath)
          });
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
          });
          res.end(generateResponsePage(true, "授权成功！您可以关闭此页面"));
          server.close(() => {
            activeKiroServers.delete("claude-kiro-oauth");
          });
        } else {
          res.writeHead(204);
          res.end();
        }
      } catch (error) {
        logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
        res.writeHead(500, {
          "Content-Type": "text/html; charset=utf-8"
        });
        res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
      }
    });
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
    setTimeout(() => {
      if (server.listening) {
        server.close(() => {
          activeKiroServers.delete("claude-kiro-oauth");
        });
      }
    }, KIRO_OAUTH_CONFIG.authTimeout);
  });
}

const KIRO_REFRESH_CONSTANTS = {
  REFRESH_URL: "https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken",
  REFRESH_IDC_URL: "https://oidc.{{region}}.amazonaws.com/token",
  CONTENT_TYPE_JSON: "application/json",
  AUTH_METHOD_SOCIAL: "social",
  DEFAULT_PROVIDER: "Google",
  REQUEST_TIMEOUT: 3e4,
  DEFAULT_REGION: "us-east-1",
  IDC_REGION: "us-east-1"
};

async function refreshKiroToken(refreshToken, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION) {
  const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_URL.replace("{{region}}", region);
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), KIRO_REFRESH_CONSTANTS.REQUEST_TIMEOUT);
  try {
    const response = await fetchWithProxy(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": KIRO_REFRESH_CONSTANTS.CONTENT_TYPE_JSON
      },
      body: JSON.stringify({
        refreshToken: refreshToken
      }),
      signal: controller.signal
    }, "claude-kiro-oauth");
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    if (!data.accessToken) {
      throw new Error("Invalid refresh response: Missing accessToken");
    }
    const expiresIn = data.expiresIn || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1e3).toISOString();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn || "",
      expiresAt: expiresAt,
      authMethod: KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL,
      provider: KIRO_REFRESH_CONSTANTS.DEFAULT_PROVIDER,
      region: region
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("Request timeout");
    }
    throw error;
  }
}

export async function checkKiroCredentialsDuplicate(refreshToken, provider = "claude-kiro-oauth") {
  const kiroDir = path.join(process.cwd(), "configs", "kiro");
  try {
    if (!fs.existsSync(kiroDir)) {
      return {
        isDuplicate: false
      };
    }
    const scanDirectory = async dirPath => {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true
      });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const result = await scanDirectory(fullPath);
          if (result.isDuplicate) {
            return result;
          }
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const content = await fs.promises.readFile(fullPath, "utf8");
            const credentials = JSON.parse(content);
            if (credentials.refreshToken && credentials.refreshToken === refreshToken) {
              const relativePath = path.relative(process.cwd(), fullPath);
              logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Found duplicate refreshToken in: ${relativePath}`);
              return {
                isDuplicate: true,
                existingPath: relativePath
              };
            }
          } catch (parseError) {}
        }
      }
      return {
        isDuplicate: false
      };
    };
    return await scanDirectory(kiroDir);
  } catch (error) {
    logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
    return {
      isDuplicate: false
    };
  }
}

export async function batchImportKiroRefreshTokens(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, skipDuplicateCheck = false) {
  const results = {
    total: refreshTokens.length,
    success: 0,
    failed: 0,
    details: []
  };
  for (let i = 0; i < refreshTokens.length; i++) {
    const refreshToken = refreshTokens[i].trim();
    if (!refreshToken) {
      results.details.push({
        index: i + 1,
        success: false,
        error: "Empty token"
      });
      results.failed++;
      continue;
    }
    if (!skipDuplicateCheck) {
      const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
      if (duplicateCheck.isDuplicate) {
        results.details.push({
          index: i + 1,
          success: false,
          error: "duplicate",
          existingPath: duplicateCheck.existingPath
        });
        results.failed++;
        continue;
      }
    }
    try {
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
      const tokenData = await refreshKiroToken(refreshToken, region);
      const timestamp = Date.now();
      const folderName = `${timestamp}_kiro-auth-token`;
      const targetDir = path.join(process.cwd(), "configs", "kiro", folderName);
      await fs.promises.mkdir(targetDir, {
        recursive: true
      });
      const credPath = path.join(targetDir, `${folderName}.json`);
      await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
      const relativePath = path.relative(process.cwd(), credPath);
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${relativePath}`);
      results.details.push({
        index: i + 1,
        success: true,
        path: relativePath,
        expiresAt: tokenData.expiresAt
      });
      results.success++;
    } catch (error) {
      logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
      results.details.push({
        index: i + 1,
        success: false,
        error: error.message
      });
      results.failed++;
    }
  }
  if (results.success > 0) {
    broadcastEvent("oauth_batch_success", {
      provider: "claude-kiro-oauth",
      count: results.success,
      timestamp: (new Date).toISOString()
    });
    for (const detail of results.details) {
      if (detail.success && detail.path) {
        await autoLinkProviderConfigs(CONFIG, {
          onlyCurrentCred: true,
          credPath: detail.path
        });
      }
    }
  }
  return results;
}

export async function batchImportKiroRefreshTokensStream(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, onProgress = null, skipDuplicateCheck = false) {
  const results = {
    total: refreshTokens.length,
    success: 0,
    failed: 0,
    details: []
  };
  for (let i = 0; i < refreshTokens.length; i++) {
    const refreshToken = refreshTokens[i].trim();
    const progressData = {
      index: i + 1,
      total: refreshTokens.length,
      current: null
    };
    if (!refreshToken) {
      progressData.current = {
        index: i + 1,
        success: false,
        error: "Empty token"
      };
      results.details.push(progressData.current);
      results.failed++;
      if (onProgress) {
        onProgress({
          ...progressData,
          successCount: results.success,
          failedCount: results.failed
        });
      }
      continue;
    }
    if (!skipDuplicateCheck) {
      const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
      if (duplicateCheck.isDuplicate) {
        progressData.current = {
          index: i + 1,
          success: false,
          error: "duplicate",
          existingPath: duplicateCheck.existingPath
        };
        results.details.push(progressData.current);
        results.failed++;
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
    try {
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
      const tokenData = await refreshKiroToken(refreshToken, region);
      const timestamp = Date.now();
      const folderName = `${timestamp}_kiro-auth-token`;
      const targetDir = path.join(process.cwd(), "configs", "kiro", folderName);
      await fs.promises.mkdir(targetDir, {
        recursive: true
      });
      const credPath = path.join(targetDir, `${folderName}.json`);
      await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
      const relativePath = path.relative(process.cwd(), credPath);
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${relativePath}`);
      progressData.current = {
        index: i + 1,
        success: true,
        path: relativePath,
        expiresAt: tokenData.expiresAt
      };
      results.details.push(progressData.current);
      results.success++;
    } catch (error) {
      logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
      progressData.current = {
        index: i + 1,
        success: false,
        error: error.message
      };
      results.details.push(progressData.current);
      results.failed++;
    }
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
      provider: "claude-kiro-oauth",
      count: results.success,
      timestamp: (new Date).toISOString()
    });
    for (const detail of results.details) {
      if (detail.success && detail.path) {
        await autoLinkProviderConfigs(CONFIG, {
          onlyCurrentCred: true,
          credPath: detail.path
        });
      }
    }
  }
  return results;
}

export async function importAwsCredentials(credentials, skipDuplicateCheck = false) {
  try {
    const missingFields = [];
    if (!credentials.clientId) missingFields.push("clientId");
    if (!credentials.clientSecret) missingFields.push("clientSecret");
    if (!credentials.accessToken) missingFields.push("accessToken");
    if (!credentials.refreshToken) missingFields.push("refreshToken");
    if (missingFields.length > 0) {
      return {
        success: false,
        error: `Missing required fields: ${missingFields.join(", ")}`
      };
    }
    if (!skipDuplicateCheck) {
      const duplicateCheck = await checkKiroCredentialsDuplicate(credentials.refreshToken);
      if (duplicateCheck.isDuplicate) {
        return {
          success: false,
          error: "duplicate",
          existingPath: duplicateCheck.existingPath
        };
      }
    }
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Importing AWS credentials...`);
    const credentialsData = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      authMethod: credentials.authMethod || "builder-id",
      idcRegion: credentials.idcRegion || KIRO_REFRESH_CONSTANTS.IDC_REGION
    };
    if (credentials.expiresAt) {
      credentialsData.expiresAt = credentials.expiresAt;
    }
    if (credentials.startUrl) {
      credentialsData.startUrl = credentials.startUrl;
    }
    if (credentials.registrationExpiresAt) {
      credentialsData.registrationExpiresAt = credentials.registrationExpiresAt;
    }
    try {
      logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Attempting to refresh token with provided credentials...`);
      const refreshRegion = credentials.idcRegion || KIRO_REFRESH_CONSTANTS.IDC_REGION;
      const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_IDC_URL.replace("{{region}}", refreshRegion);
      const refreshResponse = await fetchWithProxy(refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          refreshToken: credentials.refreshToken,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          grantType: "refresh_token"
        })
      }, "claude-kiro-oauth");
      if (refreshResponse.ok) {
        const tokenData = await refreshResponse.json();
        credentialsData.accessToken = tokenData.accessToken;
        credentialsData.refreshToken = tokenData.refreshToken;
        const expiresIn = tokenData.expiresIn || 3600;
        credentialsData.expiresAt = new Date(Date.now() + expiresIn * 1e3).toISOString();
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token refreshed successfully`);
      } else {
        logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh failed, saving original credentials`);
      }
    } catch (refreshError) {
      logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh error:`, refreshError.message);
    }
    const timestamp = Date.now();
    const folderName = `${timestamp}_kiro-auth-token`;
    const targetDir = path.join(process.cwd(), "configs", "kiro", folderName);
    await fs.promises.mkdir(targetDir, {
      recursive: true
    });
    const credPath = path.join(targetDir, `${folderName}.json`);
    await fs.promises.writeFile(credPath, JSON.stringify(credentialsData, null, 2));
    const relativePath = path.relative(process.cwd(), credPath);
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials saved to: ${relativePath}`);
    broadcastEvent("oauth_success", {
      provider: "claude-kiro-oauth",
      relativePath: relativePath,
      timestamp: (new Date).toISOString()
    });
    await autoLinkProviderConfigs(CONFIG, {
      onlyCurrentCred: true,
      credPath: relativePath
    });
    return {
      success: true,
      path: relativePath
    };
  } catch (error) {
    logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials import failed:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}