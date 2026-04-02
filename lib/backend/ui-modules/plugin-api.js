import { getPluginManager } from "../core/plugin-manager.js";

import logger from "../utils/logger.js";

import { getRequestBody } from "../utils/common.js";

import { broadcastEvent } from "./event-broadcast.js";

export async function handleGetPlugins(req, res) {
  try {
    const pluginManager = getPluginManager();
    const plugins = pluginManager.getPluginList();
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      plugins: plugins
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to get plugins:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to get plugins list: " + error.message
      }
    }));
    return true;
  }
}

export async function handleTogglePlugin(req, res, pluginName) {
  try {
    const body = await getRequestBody(req);
    const {enabled: enabled} = body;
    if (typeof enabled !== "boolean") {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Enabled status must be a boolean"
        }
      }));
      return true;
    }
    const pluginManager = getPluginManager();
    await pluginManager.setPluginEnabled(pluginName, enabled);
    broadcastEvent("plugin_update", {
      action: "toggle",
      pluginName: pluginName,
      enabled: enabled,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Plugin ${pluginName} ${enabled ? "enabled" : "disabled"} successfully`,
      plugin: {
        name: pluginName,
        enabled: enabled
      }
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to toggle plugin:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to toggle plugin: " + error.message
      }
    }));
    return true;
  }
}