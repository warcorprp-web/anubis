import { existsSync, readFileSync } from "fs";

import path from "path";

import * as auth from "../ui-modules/auth.js";

import * as configApi from "../ui-modules/config-api.js";

import * as providerApi from "../ui-modules/provider-api.js";

import * as usageApi from "../ui-modules/usage-api.js";

import * as pluginApi from "../ui-modules/plugin-api.js";

import * as uploadConfigApi from "../ui-modules/upload-config-api.js";

import * as systemApi from "../ui-modules/system-api.js";

import * as updateApi from "../ui-modules/update-api.js";

import * as oauthApi from "../ui-modules/oauth-api.js";

import * as eventBroadcast from "../ui-modules/event-broadcast.js";

export { broadcastEvent, initializeUIManagement, handleUploadOAuthCredentials, upload } from "../ui-modules/event-broadcast.js";

export async function serveStaticFiles(pathParam, res) {
  const filePath = path.join(process.cwd(), "static", pathParam === "/" || pathParam === "/index.html" ? "index.html" : pathParam.replace("/static/", ""));
  if (existsSync(filePath)) {
    const ext = path.extname(filePath);
    const contentType = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon"
    }[ext] || "text/plain";
    res.writeHead(200, {
      "Content-Type": contentType
    });
    res.end(readFileSync(filePath));
    return true;
  }
  return false;
}

export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
  if (method === "POST" && pathParam === "/api/login") {
    return await auth.handleLoginRequest(req, res);
  }
  if (method === "GET" && pathParam === "/api/health") {
    return await systemApi.handleHealthCheck(req, res);
  }
  if (pathParam.startsWith("/api/") && pathParam !== "/api/login" && pathParam !== "/api/health" && pathParam !== "/api/events" && pathParam !== "/api/grok/assets") {
    const isAuth = await auth.checkAuth(req);
    if (!isAuth) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      res.end(JSON.stringify({
        error: {
          message: "Unauthorized access, please login first",
          code: "UNAUTHORIZED"
        }
      }));
      return true;
    }
  }
  if (method === "POST" && pathParam === "/api/upload-oauth-credentials") {
    return await eventBroadcast.handleUploadOAuthCredentials(req, res);
  }
  if (method === "POST" && pathParam === "/api/admin-password") {
    return await configApi.handleUpdateAdminPassword(req, res);
  }
  if (method === "GET" && pathParam === "/api/config") {
    return await configApi.handleGetConfig(req, res, currentConfig);
  }
  if (method === "POST" && pathParam === "/api/config") {
    return await configApi.handleUpdateConfig(req, res, currentConfig);
  }
  if (method === "GET" && pathParam === "/api/system") {
    return await systemApi.handleGetSystem(req, res);
  }
  if (method === "GET" && pathParam === "/api/system/download-log") {
    return await systemApi.handleDownloadTodayLog(req, res);
  }
  if (method === "POST" && pathParam === "/api/system/clear-log") {
    return await systemApi.handleClearTodayLog(req, res);
  }
  if (method === "GET" && pathParam === "/api/providers") {
    return await providerApi.handleGetProviders(req, res, currentConfig, providerPoolManager);
  }
  if (method === "GET" && pathParam === "/api/providers/supported") {
    return await providerApi.handleGetSupportedProviders(req, res);
  }
  const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
  if (method === "GET" && providerTypeMatch) {
    const providerType = decodeURIComponent(providerTypeMatch[1]);
    return await providerApi.handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType);
  }
  if (method === "GET" && pathParam === "/api/provider-models") {
    return await providerApi.handleGetProviderModels(req, res);
  }
  const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
  if (method === "GET" && providerModelsMatch) {
    const providerType = decodeURIComponent(providerModelsMatch[1]);
    return await providerApi.handleGetProviderTypeModels(req, res, providerType);
  }
  if (method === "POST" && pathParam === "/api/providers") {
    return await providerApi.handleAddProvider(req, res, currentConfig, providerPoolManager);
  }
  const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
  if (method === "POST" && resetHealthMatch) {
    const providerType = decodeURIComponent(resetHealthMatch[1]);
    return await providerApi.handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType);
  }
  const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
  if (method === "POST" && healthCheckMatch) {
    const providerType = decodeURIComponent(healthCheckMatch[1]);
    return await providerApi.handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType);
  }
  const deleteUnhealthyMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/delete-unhealthy$/);
  if (method === "DELETE" && deleteUnhealthyMatch) {
    const providerType = decodeURIComponent(deleteUnhealthyMatch[1]);
    return await providerApi.handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType);
  }
  const refreshUnhealthyUuidsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/refresh-unhealthy-uuids$/);
  if (method === "POST" && refreshUnhealthyUuidsMatch) {
    const providerType = decodeURIComponent(refreshUnhealthyUuidsMatch[1]);
    return await providerApi.handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType);
  }
  const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
  if (disableEnableProviderMatch) {
    const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
    const providerUuid = disableEnableProviderMatch[2];
    const action = disableEnableProviderMatch[3];
    return await providerApi.handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action);
  }
  const refreshUuidMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-uuid$/);
  if (method === "POST" && refreshUuidMatch) {
    const providerType = decodeURIComponent(refreshUuidMatch[1]);
    const providerUuid = refreshUuidMatch[2];
    return await providerApi.handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
  }
  const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
  if (method === "PUT" && updateProviderMatch) {
    const providerType = decodeURIComponent(updateProviderMatch[1]);
    const providerUuid = updateProviderMatch[2];
    return await providerApi.handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
  }
  if (method === "DELETE" && updateProviderMatch) {
    const providerType = decodeURIComponent(updateProviderMatch[1]);
    const providerUuid = updateProviderMatch[2];
    return await providerApi.handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
  }
  const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
  if (method === "POST" && generateAuthUrlMatch) {
    const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
    return await oauthApi.handleGenerateAuthUrl(req, res, currentConfig, providerType);
  }
  if (method === "POST" && pathParam === "/api/oauth/manual-callback") {
    return await oauthApi.handleManualOAuthCallback(req, res);
  }
  if (method === "GET" && pathParam === "/api/events") {
    return await eventBroadcast.handleEvents(req, res);
  }
  if (method === "GET" && pathParam === "/api/upload-configs") {
    return await uploadConfigApi.handleGetUploadConfigs(req, res, currentConfig, providerPoolManager);
  }
  const viewConfigMatch = pathParam.match(/^\/api\/upload-configs\/view\/(.+)$/);
  if (method === "GET" && viewConfigMatch) {
    const filePath = decodeURIComponent(viewConfigMatch[1]);
    return await uploadConfigApi.handleViewConfigFile(req, res, filePath);
  }
  const downloadConfigMatch = pathParam.match(/^\/api\/upload-configs\/download\/(.+)$/);
  if (method === "GET" && downloadConfigMatch) {
    const filePath = decodeURIComponent(downloadConfigMatch[1]);
    return await uploadConfigApi.handleDownloadConfigFile(req, res, filePath);
  }
  const deleteConfigMatch = pathParam.match(/^\/api\/upload-configs\/delete\/(.+)$/);
  if (method === "DELETE" && deleteConfigMatch) {
    const filePath = decodeURIComponent(deleteConfigMatch[1]);
    return await uploadConfigApi.handleDeleteConfigFile(req, res, filePath);
  }
  if (method === "GET" && pathParam === "/api/upload-configs/download-all") {
    return await uploadConfigApi.handleDownloadAllConfigs(req, res);
  }
  if (method === "DELETE" && pathParam === "/api/upload-configs/delete-unbound") {
    return await uploadConfigApi.handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager);
  }
  if (method === "POST" && pathParam === "/api/quick-link-provider") {
    return await providerApi.handleQuickLinkProvider(req, res, currentConfig, providerPoolManager);
  }
  if (method === "GET" && pathParam === "/api/usage") {
    return await usageApi.handleGetUsage(req, res, currentConfig, providerPoolManager);
  }
  if (method === "GET" && pathParam === "/api/usage/supported-providers") {
    return await usageApi.handleGetSupportedProviders(req, res);
  }
  const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
  if (method === "GET" && usageProviderMatch) {
    const providerType = decodeURIComponent(usageProviderMatch[1]);
    return await usageApi.handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
  }
  if (method === "GET" && pathParam === "/api/check-update") {
    return await updateApi.handleCheckUpdate(req, res);
  }
  if (method === "POST" && pathParam === "/api/update") {
    return await updateApi.handlePerformUpdate(req, res);
  }
  if (method === "POST" && pathParam === "/api/reload-config") {
    return await configApi.handleReloadConfig(req, res, providerPoolManager);
  }
  if (method === "POST" && pathParam === "/api/restart-service") {
    return await systemApi.handleRestartService(req, res);
  }
  if (method === "GET" && pathParam === "/api/service-mode") {
    return await systemApi.handleGetServiceMode(req, res);
  }
  if (method === "POST" && pathParam === "/api/kiro/batch-import-tokens") {
    return await oauthApi.handleBatchImportKiroTokens(req, res);
  }
  if (method === "POST" && pathParam === "/api/gemini/batch-import-tokens") {
    return await oauthApi.handleBatchImportGeminiTokens(req, res);
  }
  if (method === "POST" && pathParam === "/api/codex/batch-import-tokens") {
    return await oauthApi.handleBatchImportCodexTokens(req, res);
  }
  if (method === "POST" && pathParam === "/api/kiro/import-aws-credentials") {
    return await oauthApi.handleImportAwsCredentials(req, res);
  }
  if (method === "GET" && pathParam === "/api/plugins") {
    return await pluginApi.handleGetPlugins(req, res);
  }
  const togglePluginMatch = pathParam.match(/^\/api\/plugins\/(.+)\/toggle$/);
  if (method === "POST" && togglePluginMatch) {
    const pluginName = decodeURIComponent(togglePluginMatch[1]);
    return await pluginApi.handleTogglePlugin(req, res, pluginName);
  }
  return false;
}