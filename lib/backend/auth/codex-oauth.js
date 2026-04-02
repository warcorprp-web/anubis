import http from "http";

import logger from "../utils/logger.js";

import fs from "fs";

import path from "path";

import crypto from "crypto";

import open from "open";

import axios from "axios";

import { broadcastEvent } from "../services/ui-adapter";

import { autoLinkProviderConfigs } from "../services/service-adapter";

import { CONFIG } from "../core/config-adapter";

import { getProxyConfigForProvider } from "../services/service-adapter";

const CODEX_OAUTH_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  port: 1455,
  scopes: "openid email profile offline_access",
  logPrefix: "[Codex Auth]"
};

const activeServers = new Map;

async function closeActiveServer(provider, port = null) {
  const existing = activeServers.get(provider);
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
      logger.info(`[Codex Auth] ${provider} server closed successfully`);
    } catch (error) {
      logger.warn(`[Codex Auth] Server close failed or timed out: ${error.message}`);
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

class CodexAuth {
  constructor(config) {
    this.config = config;
    const axiosConfig = {
      timeout: 3e4
    };
    const proxyConfig = getProxyConfigForProvider(config, "openai-codex-oauth");
    if (proxyConfig) {
      axiosConfig.httpAgent = proxyConfig.httpAgent;
      axiosConfig.httpsAgent = proxyConfig.httpsAgent;
      logger.info("[Codex Auth] Proxy enabled for OAuth requests");
    }
    this.httpClient = axios.create(axiosConfig);
    this.server = null;
  }
  generatePKCECodes() {
    const verifier = crypto.randomBytes(96).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return {
      verifier: verifier,
      challenge: challenge
    };
  }
  async generateAuthUrl() {
    const pkce = this.generatePKCECodes();
    const state = crypto.randomBytes(16).toString("hex");
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Generating auth URL...`);
    const server = await this.startCallbackServer();
    this.server = server;
    const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
    authUrl.searchParams.set("client_id", CODEX_OAUTH_CONFIG.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", CODEX_OAUTH_CONFIG.redirectUri);
    authUrl.searchParams.set("scope", CODEX_OAUTH_CONFIG.scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("prompt", "login");
    authUrl.searchParams.set("id_token_add_organizations", "true");
    authUrl.searchParams.set("codex_cli_simplified_flow", "true");
    return {
      authUrl: authUrl.toString(),
      state: state,
      pkce: pkce,
      server: server
    };
  }
  async completeOAuthFlow(code, state, expectedState, pkce) {
    if (state !== expectedState) {
      throw new Error("State mismatch - possible CSRF attack");
    }
    const tokens = await this.exchangeCodeForTokens(code, pkce.verifier);
    const claims = this.parseJWT(tokens.id_token);
    const credentials = {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.sub,
      last_refresh: (new Date).toISOString(),
      email: claims.email,
      type: "codex",
      expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1e3).toISOString()
    };
    const saveResult = await this.saveCredentials(credentials);
    const credPath = saveResult.credsPath;
    const relativePath = saveResult.relativePath;
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    return {
      ...credentials,
      credPath: credPath,
      relativePath: relativePath
    };
  }
  async startOAuthFlow() {
    const pkce = this.generatePKCECodes();
    const state = crypto.randomBytes(16).toString("hex");
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Starting OAuth flow...`);
    const server = await this.startCallbackServer();
    const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
    authUrl.searchParams.set("client_id", CODEX_OAUTH_CONFIG.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", CODEX_OAUTH_CONFIG.redirectUri);
    authUrl.searchParams.set("scope", CODEX_OAUTH_CONFIG.scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("prompt", "login");
    authUrl.searchParams.set("id_token_add_organizations", "true");
    authUrl.searchParams.set("codex_cli_simplified_flow", "true");
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Opening browser for authentication...`);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} If browser doesn't open, visit: ${authUrl.toString()}`);
    try {
      await open(authUrl.toString());
    } catch (error) {
      logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to open browser automatically:`, error.message);
    }
    const result = await this.waitForCallback(server, state);
    const tokens = await this.exchangeCodeForTokens(result.code, pkce.verifier);
    const claims = this.parseJWT(tokens.id_token);
    const credentials = {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.sub,
      last_refresh: (new Date).toISOString(),
      email: claims.email,
      type: "codex",
      expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1e3).toISOString()
    };
    await this.saveCredentials(credentials);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);
    return credentials;
  }
  async startCallbackServer() {
    await closeActiveServer("openai-codex-oauth", CODEX_OAUTH_CONFIG.port);
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      server.on("request", (req, res) => {
        if (req.url.startsWith("/auth/callback")) {
          const url = new URL(req.url, `http://localhost:${CODEX_OAUTH_CONFIG.port}`);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDescription = url.searchParams.get("error_description");
          if (error) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(`\n                            <!DOCTYPE html>\n                            <html>\n                            <head>\n                                <title>Authentication Failed</title>\n                                <style>\n                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }\n                                    h1 { color: #d32f2f; }\n                                    p { color: #666; }\n                                </style>\n                            </head>\n                            <body>\n                                <h1>❌ Authentication Failed</h1>\n                                <p>${errorDescription || error}</p>\n                                <p>You can close this window and try again.</p>\n                            </body>\n                            </html>\n                        `);
            server.emit("auth-error", new Error(errorDescription || error));
          } else if (code && state) {
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8"
            });
            res.end(`\n                            <!DOCTYPE html>\n                            <html>\n                            <head>\n                                <title>Authentication Successful</title>\n                                <style>\n                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }\n                                    h1 { color: #4caf50; }\n                                    p { color: #666; }\n                                    .countdown { font-size: 24px; font-weight: bold; color: #2196f3; }\n                                </style>\n                                <script>\n                                    let countdown = 10;\n                                    setInterval(() => {\n                                        countdown--;\n                                        document.getElementById('countdown').textContent = countdown;\n                                        if (countdown <= 0) {\n                                            window.close();\n                                        }\n                                    }, 1000);\n                                <\/script>\n                            </head>\n                            <body>\n                                <h1>✅ Authentication Successful!</h1>\n                                <p>You can now close this window and return to the application.</p>\n                                <p>This window will close automatically in <span id="countdown" class="countdown">10</span> seconds.</p>\n                            </body>\n                            </html>\n                        `);
            server.emit("auth-success", {
              code: code,
              state: state
            });
          }
        } else if (req.url === "/success") {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
          });
          res.end("<h1>Success!</h1>");
        }
      });
      server.listen(CODEX_OAUTH_CONFIG.port, "0.0.0.0", () => {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Callback server listening on port ${CODEX_OAUTH_CONFIG.port}`);
        activeServers.set("openai-codex-oauth", {
          server: server,
          port: CODEX_OAUTH_CONFIG.port
        });
        resolve(server);
      });
      server.on("error", error => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Port ${CODEX_OAUTH_CONFIG.port} is already in use. Please close other applications using this port.`));
        } else {
          reject(error);
        }
      });
    });
  }
  async waitForCallback(server, expectedState) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Authentication timeout (10 minutes)"));
      }, 10 * 60 * 1e3);
      server.once("auth-success", result => {
        clearTimeout(timeout);
        server.close();
        if (result.state !== expectedState) {
          reject(new Error("State mismatch - possible CSRF attack"));
        } else {
          resolve(result);
        }
      });
      server.once("auth-error", error => {
        clearTimeout(timeout);
        server.close();
        reject(error);
      });
    });
  }
  async exchangeCodeForTokens(code, codeVerifier) {
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Exchanging authorization code for tokens...`);
    try {
      const response = await this.httpClient.post(CODEX_OAUTH_CONFIG.tokenUrl, new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code: code,
        redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
        code_verifier: codeVerifier
      }).toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token exchange failed:`, error.response?.data || error.message);
      throw new Error(`Failed to exchange code for tokens: ${error.response?.data?.error_description || error.message}`);
    }
  }
  async refreshTokens(refreshToken) {
    logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Refreshing access token...`);
    try {
      const response = await this.httpClient.post(CODEX_OAUTH_CONFIG.tokenUrl, new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        refresh_token: refreshToken
      }).toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        }
      });
      const tokens = response.data;
      const claims = this.parseJWT(tokens.id_token);
      return {
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || refreshToken,
        account_id: claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.sub,
        last_refresh: (new Date).toISOString(),
        email: claims.email,
        type: "codex",
        expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1e3).toISOString()
      };
    } catch (error) {
      logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token refresh failed:`, error.response?.data || error.message);
      throw new Error(`Failed to refresh tokens: ${error.response?.data?.error_description || error.message}`);
    }
  }
  parseJWT(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new Error("Invalid JWT token format");
      }
      const payload = Buffer.from(parts[1], "base64url").toString("utf8");
      return JSON.parse(payload);
    } catch (error) {
      logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to parse JWT:`, error.message);
      throw new Error(`Failed to parse JWT token: ${error.message}`);
    }
  }
  async saveCredentials(creds) {
    const email = creds.email || this.config.CODEX_EMAIL || "default";
    let credsPath;
    if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
      credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
    } else {
      const projectDir = process.cwd();
      const targetDir = path.join(projectDir, "configs", "codex");
      await fs.promises.mkdir(targetDir, {
        recursive: true
      });
      const timestamp = Date.now();
      const filename = `${timestamp}_codex-${email}.json`;
      credsPath = path.join(targetDir, filename);
    }
    try {
      const credsDir = path.dirname(credsPath);
      await fs.promises.mkdir(credsDir, {
        recursive: true
      });
      await fs.promises.writeFile(credsPath, JSON.stringify(creds, null, 2), {
        mode: 384
      });
      const relativePath = path.relative(process.cwd(), credsPath);
      logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Credentials saved to ${relativePath}`);
      return {
        credsPath: credsPath,
        relativePath: relativePath
      };
    } catch (error) {
      logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to save credentials:`, error.message);
      throw new Error(`Failed to save credentials: ${error.message}`);
    }
  }
  async loadCredentials(email) {
    let credsPath;
    if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
      credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
    } else {
      const projectDir = process.cwd();
      const targetDir = path.join(projectDir, "configs", "codex");
      try {
        const files = await fs.promises.readdir(targetDir);
        const emailPattern = email || "default";
        const matchingFile = files.filter(f => f.includes(`codex-${emailPattern}`) && f.endsWith(".json")).sort().pop();
        if (matchingFile) {
          credsPath = path.join(targetDir, matchingFile);
        } else {
          return null;
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }
    try {
      const data = await fs.promises.readFile(credsPath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  async credentialsExist(email) {
    let credsPath;
    if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
      credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
    } else {
      const projectDir = process.cwd();
      const targetDir = path.join(projectDir, "configs", "codex");
      try {
        const files = await fs.promises.readdir(targetDir);
        const emailPattern = email || "default";
        const hasMatch = files.some(f => f.includes(`codex-${emailPattern}`) && f.endsWith(".json"));
        return hasMatch;
      } catch (error) {
        return false;
      }
    }
    try {
      await fs.promises.access(credsPath);
      return true;
    } catch {
      return false;
    }
  }
  async checkDuplicate(accountId, refreshToken) {
    const projectDir = process.cwd();
    const targetDir = path.join(projectDir, "configs", "codex");
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
            if (accountId && credentials.account_id === accountId || refreshToken && credentials.refresh_token === refreshToken) {
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
      logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
      return {
        isDuplicate: false
      };
    }
  }
}

export async function batchImportCodexTokensStream(tokens, onProgress = null, skipDuplicateCheck = false) {
  const auth = new CodexAuth({});
  const results = {
    total: tokens.length,
    success: 0,
    failed: 0,
    details: []
  };
  for (let i = 0; i < tokens.length; i++) {
    const tokenData = tokens[i];
    const progressData = {
      index: i + 1,
      total: tokens.length,
      current: null
    };
    try {
      if (!tokenData.access_token || !tokenData.id_token) {
        throw new Error("Token 缺少必需字段 (access_token 或 id_token)");
      }
      const claims = auth.parseJWT(tokenData.id_token);
      const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.sub;
      const email = claims.email;
      if (!skipDuplicateCheck) {
        const duplicateCheck = await auth.checkDuplicate(accountId, tokenData.refresh_token);
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
      const credentials = {
        id_token: tokenData.id_token,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        account_id: accountId,
        last_refresh: (new Date).toISOString(),
        email: email,
        type: "codex",
        expired: new Date(Date.now() + (tokenData.expires_in || 3600) * 1e3).toISOString()
      };
      const saveResult = await auth.saveCredentials(credentials);
      const relativePath = saveResult.relativePath;
      logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} imported: ${relativePath}`);
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
      logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} import failed:`, error.message);
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
      provider: "openai-codex-oauth",
      count: results.success,
      timestamp: (new Date).toISOString()
    });
  }
  return results;
}

export async function refreshCodexTokensWithRetry(refreshToken, config = {}, maxRetries = 3) {
  const auth = new CodexAuth(config);
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await auth.refreshTokens(refreshToken);
    } catch (error) {
      lastError = error;
      logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Retry ${i + 1}/${maxRetries} failed:`, error.message);
      if (i < maxRetries - 1) {
        const delay = Math.min(1e3 * Math.pow(2, i), 1e4);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export async function handleCodexOAuth(currentConfig, options = {}) {
  const auth = new CodexAuth(currentConfig);
  try {
    logger.info("[Codex Auth] Generating OAuth URL...");
    if (global.codexOAuthSessions && global.codexOAuthSessions.size > 0) {
      logger.info("[Codex Auth] Cleaning up old OAuth sessions...");
      for (const [sessionId, session] of global.codexOAuthSessions.entries()) {
        try {
          if (session.pollTimer) {
            clearInterval(session.pollTimer);
          }
          global.codexOAuthSessions.delete(sessionId);
        } catch (error) {
          logger.warn(`[Codex Auth] Failed to clean up session ${sessionId}:`, error.message);
        }
      }
    }
    const {authUrl: authUrl, state: state, pkce: pkce, server: server} = await auth.generateAuthUrl();
    logger.info("[Codex Auth] OAuth URL generated successfully");
    if (!global.codexOAuthSessions) {
      global.codexOAuthSessions = new Map;
    }
    const sessionId = state;
    let pollCount = 0;
    const maxPollCount = 100;
    const pollInterval = 3e3;
    let pollTimer = null;
    let isCompleted = false;
    const session = {
      auth: auth,
      state: state,
      pkce: pkce,
      server: server,
      pollTimer: null,
      createdAt: Date.now()
    };
    global.codexOAuthSessions.set(sessionId, session);
    pollTimer = setInterval(() => {
      pollCount++;
      if (pollCount <= maxPollCount && !isCompleted) {
        logger.info(`[Codex Auth] Waiting for callback... (${pollCount}/${maxPollCount})`);
      }
      if (pollCount >= maxPollCount && !isCompleted) {
        clearInterval(pollTimer);
        const totalSeconds = maxPollCount * pollInterval / 1e3;
        logger.info(`[Codex Auth] Polling timeout (${totalSeconds}s), releasing session for next authorization`);
        if (global.codexOAuthSessions.has(sessionId)) {
          global.codexOAuthSessions.delete(sessionId);
        }
      }
    }, pollInterval);
    session.pollTimer = pollTimer;
    server.once("auth-success", async result => {
      isCompleted = true;
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      try {
        logger.info("[Codex Auth] Received auth callback, completing OAuth flow...");
        const session = global.codexOAuthSessions.get(sessionId);
        if (!session) {
          logger.error("[Codex Auth] Session not found");
          return;
        }
        const credentials = await auth.completeOAuthFlow(result.code, result.state, session.state, session.pkce);
        global.codexOAuthSessions.delete(sessionId);
        broadcastEvent("oauth_success", {
          provider: "openai-codex-oauth",
          credPath: credentials.credPath,
          relativePath: credentials.relativePath,
          timestamp: (new Date).toISOString(),
          email: credentials.email,
          accountId: credentials.account_id
        });
        await autoLinkProviderConfigs(CONFIG, {
          onlyCurrentCred: true,
          credPath: credentials.relativePath
        });
        logger.info("[Codex Auth] OAuth flow completed successfully");
      } catch (error) {
        logger.error("[Codex Auth] Failed to complete OAuth flow:", error.message);
        broadcastEvent("oauth_error", {
          provider: "openai-codex-oauth",
          error: error.message,
          timestamp: (new Date).toISOString()
        });
      }
    });
    server.once("auth-error", error => {
      isCompleted = true;
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      logger.error("[Codex Auth] Auth error:", error.message);
      global.codexOAuthSessions.delete(sessionId);
      broadcastEvent("oauth_error", {
        provider: "openai-codex-oauth",
        error: error.message,
        timestamp: (new Date).toISOString()
      });
    });
    return {
      success: true,
      authUrl: authUrl,
      authInfo: {
        provider: "openai-codex-oauth",
        method: "oauth2-pkce",
        sessionId: sessionId,
        redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
        port: CODEX_OAUTH_CONFIG.port,
        instructions: [ "1. 点击下方按钮在浏览器中打开授权链接", "2. 使用您的 OpenAI 账户登录", "3. 授权应用访问您的 Codex API", "4. 授权成功后会自动保存凭据", "5. 如果浏览器未自动跳转，请手动复制回调 URL" ]
      }
    };
  } catch (error) {
    logger.error("[Codex Auth] Failed to generate OAuth URL:", error.message);
    return {
      success: false,
      error: error.message,
      authInfo: {
        provider: "openai-codex-oauth",
        method: "oauth2-pkce",
        instructions: [ `1. 确保端口 ${CODEX_OAUTH_CONFIG.port} 未被占用`, "2. 确保可以访问 auth.openai.com", "3. 确保浏览器可以正常打开", "4. 如果问题持续，请检查网络连接" ]
      }
    };
  }
}

export async function handleCodexOAuthCallback(code, state) {
  try {
    if (!global.codexOAuthSessions || !global.codexOAuthSessions.has(state)) {
      throw new Error("Invalid or expired OAuth session");
    }
    const session = global.codexOAuthSessions.get(state);
    const {auth: auth, state: expectedState, pkce: pkce} = session;
    logger.info("[Codex Auth] Processing OAuth callback...");
    const result = await auth.completeOAuthFlow(code, state, expectedState, pkce);
    global.codexOAuthSessions.delete(state);
    broadcastEvent("oauth_success", {
      provider: "openai-codex-oauth",
      credPath: result.credPath,
      relativePath: result.relativePath,
      timestamp: (new Date).toISOString(),
      email: result.email,
      accountId: result.account_id
    });
    await autoLinkProviderConfigs(CONFIG, {
      onlyCurrentCred: true,
      credPath: result.relativePath
    });
    logger.info("[Codex Auth] OAuth callback processed successfully");
    return {
      success: true,
      message: "Codex authentication successful",
      credentials: result,
      email: result.email,
      accountId: result.account_id,
      credPath: result.credPath,
      relativePath: result.relativePath
    };
  } catch (error) {
    logger.error("[Codex Auth] OAuth callback failed:", error.message);
    broadcastEvent("oauth_error", {
      provider: "openai-codex-oauth",
      error: error.message,
      timestamp: (new Date).toISOString()
    });
    return {
      success: false,
      error: error.message
    };
  }
}