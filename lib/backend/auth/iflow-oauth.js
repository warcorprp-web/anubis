import http from "http";

import logger from "../utils/logger.js";

import fs from "fs";

import path from "path";

import os from "os";

import crypto from "crypto";

import { broadcastEvent } from "../services/ui-adapter";

import { autoLinkProviderConfigs } from "../services/service-adapter";

import { CONFIG } from "../core/config-adapter";

import { getProxyConfigForProvider } from "../services/service-adapter";

const IFLOW_OAUTH_CONFIG = {
  tokenEndpoint: "https://iflow.cn/oauth/token",
  authorizeEndpoint: "https://iflow.cn/oauth",
  userInfoEndpoint: "https://iflow.cn/api/oauth/getUserInfo",
  successRedirectURL: "https://iflow.cn/oauth/success",
  clientId: "10009311001",
  clientSecret: "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
  callbackPort: 8087,
  credentialsDir: ".iflow",
  credentialsFile: "oauth_creds.json",
  logPrefix: "[iFlow Auth]"
};

const activeIFlowServers = new Map;

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

function generateIFlowAuthorizationURL(state, port) {
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const params = new URLSearchParams({
    loginMethod: "phone",
    type: "phone",
    redirect: redirectUri,
    state: state,
    client_id: IFLOW_OAUTH_CONFIG.clientId
  });
  const authUrl = `${IFLOW_OAUTH_CONFIG.authorizeEndpoint}?${params.toString()}`;
  return {
    authUrl: authUrl,
    redirectUri: redirectUri
  };
}

async function exchangeIFlowCodeForTokens(code, redirectUri) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    client_id: IFLOW_OAUTH_CONFIG.clientId,
    client_secret: IFLOW_OAUTH_CONFIG.clientSecret
  });
  const basicAuth = Buffer.from(`${IFLOW_OAUTH_CONFIG.clientId}:${IFLOW_OAUTH_CONFIG.clientSecret}`).toString("base64");
  const response = await fetchWithProxy(IFLOW_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`
    },
    body: form.toString()
  }, "openai-iflow");
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`iFlow token exchange failed: ${response.status} ${errorText}`);
  }
  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new Error("iFlow token: missing access token in response");
  }
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenType: tokenData.token_type,
    scope: tokenData.scope,
    expiresIn: tokenData.expires_in,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1e3).toISOString()
  };
}

async function fetchIFlowUserInfo(accessToken) {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("iFlow api key: access token is empty");
  }
  const endpoint = `${IFLOW_OAUTH_CONFIG.userInfoEndpoint}?accessToken=${encodeURIComponent(accessToken)}`;
  const response = await fetchWithProxy(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  }, "openai-iflow");
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`iFlow user info failed: ${response.status} ${errorText}`);
  }
  const result = await response.json();
  if (!result.success) {
    throw new Error("iFlow api key: request not successful");
  }
  if (!result.data || !result.data.apiKey) {
    throw new Error("iFlow api key: missing api key in response");
  }
  let email = (result.data.email || "").trim();
  if (!email) {
    email = (result.data.phone || "").trim();
  }
  if (!email) {
    throw new Error("iFlow token: missing account email/phone in user info");
  }
  return {
    apiKey: result.data.apiKey,
    email: email,
    phone: result.data.phone || ""
  };
}

async function closeIFlowServer(provider, port = null) {
  const existing = activeIFlowServers.get(provider);
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
      logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
    } catch (error) {
      logger.warn(`${IFLOW_OAUTH_CONFIG.logPrefix} 关闭提供商 ${provider} 服务器失败或超时: ${error.message}`);
    } finally {
      activeIFlowServers.delete(provider);
    }
  }
  if (port) {
    for (const [p, info] of activeIFlowServers.entries()) {
      if (info.port === port) {
        await closeIFlowServer(p);
      }
    }
  }
}

function createIFlowCallbackServer(port, redirectUri, expectedState, options = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname === "/oauth2callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const errorParam = url.searchParams.get("error");
          if (errorParam) {
            logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 授权失败: ${errorParam}`);
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
            server.close(() => {
              activeIFlowServers.delete("openai-iflow");
            });
            return;
          }
          if (state !== expectedState) {
            logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} State 验证失败`);
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, "State 验证失败"));
            server.close(() => {
              activeIFlowServers.delete("openai-iflow");
            });
            return;
          }
          if (!code) {
            logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 缺少授权码`);
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, "缺少授权码"));
            server.close(() => {
              activeIFlowServers.delete("openai-iflow");
            });
            return;
          }
          logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 收到授权回调，正在交换令牌...`);
          try {
            const tokenData = await exchangeIFlowCodeForTokens(code, redirectUri);
            logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 令牌交换成功`);
            const userInfo = await fetchIFlowUserInfo(tokenData.accessToken);
            logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 用户信息获取成功: ${userInfo.email}`);
            const credentialsData = {
              access_token: tokenData.accessToken,
              refresh_token: tokenData.refreshToken,
              expiry_date: new Date(tokenData.expiresAt).getTime(),
              token_type: tokenData.tokenType,
              scope: tokenData.scope,
              apiKey: userInfo.apiKey
            };
            let credPath = path.join(os.homedir(), IFLOW_OAUTH_CONFIG.credentialsDir, IFLOW_OAUTH_CONFIG.credentialsFile);
            if (options.saveToConfigs) {
              const providerDir = options.providerDir || "iflow";
              const targetDir = path.join(process.cwd(), "configs", providerDir);
              await fs.promises.mkdir(targetDir, {
                recursive: true
              });
              const timestamp = Date.now();
              const filename = `${timestamp}_oauth_creds.json`;
              credPath = path.join(targetDir, filename);
            }
            await fs.promises.mkdir(path.dirname(credPath), {
              recursive: true
            });
            await fs.promises.writeFile(credPath, JSON.stringify(credentialsData, null, 2));
            logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 凭据已保存: ${credPath}`);
            const relativePath = path.relative(process.cwd(), credPath);
            broadcastEvent("oauth_success", {
              provider: "openai-iflow",
              credPath: credPath,
              relativePath: relativePath,
              email: userInfo.email,
              timestamp: (new Date).toISOString()
            });
            await autoLinkProviderConfigs(CONFIG, {
              onlyCurrentCred: true,
              credPath: relativePath
            });
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(true, `授权成功！账户: ${userInfo.email}，您可以关闭此页面`));
          } catch (tokenError) {
            logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 令牌处理失败:`, tokenError);
            res.writeHead(500, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(generateResponsePage(false, `令牌处理失败: ${tokenError.message}`));
          } finally {
            server.close(() => {
              activeIFlowServers.delete("openai-iflow");
            });
          }
        } else {
          res.writeHead(204);
          res.end();
        }
      } catch (error) {
        logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
        res.writeHead(500, {
          "Content-Type": "text/html; charset=utf-8"
        });
        res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
        if (server.listening) {
          server.close(() => {
            activeIFlowServers.delete("openai-iflow");
          });
        }
      }
    });
    server.on("error", err => {
      if (err.code === "EADDRINUSE") {
        logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 端口 ${port} 已被占用`);
        reject(new Error(`端口 ${port} 已被占用`));
      } else {
        logger.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 服务器错误:`, err);
        reject(err);
      }
    });
    const host = "0.0.0.0";
    server.listen(port, host, () => {
      logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} OAuth 回调服务器已启动于 ${host}:${port}`);
      resolve(server);
    });
    setTimeout(() => {
      if (server.listening) {
        logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 回调服务器超时，自动关闭`);
        server.close(() => {
          activeIFlowServers.delete("openai-iflow");
        });
      }
    }, 10 * 60 * 1e3);
  });
}

export async function handleIFlowOAuth(currentConfig, options = {}) {
  const port = parseInt(options.port) || IFLOW_OAUTH_CONFIG.callbackPort;
  const providerKey = "openai-iflow";
  const state = crypto.randomBytes(16).toString("base64url");
  const {authUrl: authUrl, redirectUri: redirectUri} = generateIFlowAuthorizationURL(state, port);
  logger.info(`${IFLOW_OAUTH_CONFIG.logPrefix} 生成授权链接: ${authUrl}`);
  await closeIFlowServer(providerKey, port);
  try {
    const server = await createIFlowCallbackServer(port, redirectUri, state, options);
    activeIFlowServers.set(providerKey, {
      server: server,
      port: port
    });
  } catch (error) {
    throw new Error(`启动 iFlow 回调服务器失败: ${error.message}`);
  }
  return {
    authUrl: authUrl,
    authInfo: {
      provider: "openai-iflow",
      redirectUri: redirectUri,
      callbackPort: port,
      state: state,
      ...options
    }
  };
}

export async function refreshIFlowTokens(refreshToken) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: IFLOW_OAUTH_CONFIG.clientId,
    client_secret: IFLOW_OAUTH_CONFIG.clientSecret
  });
  const basicAuth = Buffer.from(`${IFLOW_OAUTH_CONFIG.clientId}:${IFLOW_OAUTH_CONFIG.clientSecret}`).toString("base64");
  const response = await fetchWithProxy(IFLOW_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`
    },
    body: form.toString()
  }, "openai-iflow");
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`iFlow token refresh failed: ${response.status} ${errorText}`);
  }
  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new Error("iFlow token refresh: missing access token in response");
  }
  const userInfo = await fetchIFlowUserInfo(tokenData.access_token);
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date: Date.now() + tokenData.expires_in * 1e3,
    token_type: tokenData.token_type,
    scope: tokenData.scope,
    apiKey: userInfo.apiKey
  };
}