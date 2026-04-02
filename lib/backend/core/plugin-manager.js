import { promises as fs } from "fs";

import logger from "../utils/logger.js";

import { existsSync } from "fs";

import path from "path";

const PLUGINS_CONFIG_FILE = path.join(process.cwd(), "configs", "plugins.json");

const DEFAULT_DISABLED_PLUGINS = [ "api-potluck", "ai-monitor" ];

export const PLUGIN_TYPE = {
  AUTH: "auth",
  MIDDLEWARE: "middleware"
};

class PluginManager {
  constructor() {
    this.plugins = new Map;
    this.pluginsConfig = {
      plugins: {}
    };
    this.initialized = false;
  }
  async loadConfig() {
    try {
      const defaultConfig = await this.generateDefaultConfig();
      if (existsSync(PLUGINS_CONFIG_FILE)) {
        const content = await fs.readFile(PLUGINS_CONFIG_FILE, "utf8");
        const localConfig = JSON.parse(content);
        for (const [pluginName, defaultPluginConfig] of Object.entries(defaultConfig.plugins)) {
          const localPluginConfig = localConfig.plugins?.[pluginName];
          if (localPluginConfig) {
            defaultConfig.plugins[pluginName] = {
              ...defaultPluginConfig,
              ...localPluginConfig,
              enabled: localPluginConfig.enabled
            };
          }
        }
      }
      this.pluginsConfig = defaultConfig;
      await this.saveConfig();
    } catch (error) {
      logger.error("[PluginManager] Failed to load config:", error.message);
      this.pluginsConfig = {
        plugins: {}
      };
    }
  }
  async generateDefaultConfig() {
    const defaultConfig = {
      plugins: {}
    };
    const pluginsDir = path.join(process.cwd(), "src", "plugins");
    try {
      if (!existsSync(pluginsDir)) {
        return defaultConfig;
      }
      const entries = await fs.readdir(pluginsDir, {
        withFileTypes: true
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path.join(pluginsDir, entry.name, "index.js");
        if (!existsSync(pluginPath)) continue;
        try {
          const pluginModule = await import(`file://${pluginPath}`);
          const plugin = pluginModule.default || pluginModule;
          if (plugin && plugin.name) {
            const enabled = !DEFAULT_DISABLED_PLUGINS.includes(plugin.name);
            defaultConfig.plugins[plugin.name] = {
              enabled: enabled,
              description: plugin.description || ""
            };
            logger.info(`[PluginManager] Found plugin for default config: ${plugin.name}`);
          }
        } catch (importError) {
          const enabled = !DEFAULT_DISABLED_PLUGINS.includes(entry.name);
          defaultConfig.plugins[entry.name] = {
            enabled: enabled,
            description: ""
          };
          logger.warn(`[PluginManager] Could not import plugin ${entry.name}, using directory name:`, importError.message);
        }
      }
    } catch (error) {
      logger.error("[PluginManager] Failed to scan plugins directory:", error.message);
    }
    return defaultConfig;
  }
  async saveConfig() {
    try {
      const dir = path.dirname(PLUGINS_CONFIG_FILE);
      if (!existsSync(dir)) {
        await fs.mkdir(dir, {
          recursive: true
        });
      }
      await fs.writeFile(PLUGINS_CONFIG_FILE, JSON.stringify(this.pluginsConfig, null, 2), "utf8");
    } catch (error) {
      logger.error("[PluginManager] Failed to save config:", error.message);
    }
  }
  register(plugin) {
    if (!plugin.name) {
      throw new Error("Plugin must have a name");
    }
    if (this.plugins.has(plugin.name)) {
      logger.warn(`[PluginManager] Plugin "${plugin.name}" is already registered, skipping`);
      return;
    }
    this.plugins.set(plugin.name, plugin);
    logger.info(`[PluginManager] Registered plugin: ${plugin.name} v${plugin.version || "1.0.0"}`);
  }
  async initAll(config) {
    await this.loadConfig();
    for (const [name, plugin] of this.plugins) {
      const pluginConfig = this.pluginsConfig.plugins[name] || {};
      const enabled = pluginConfig.enabled !== false;
      if (!enabled) {
        logger.info(`[PluginManager] Plugin "${name}" is disabled, skipping init`);
        continue;
      }
      try {
        if (typeof plugin.init === "function") {
          await plugin.init(config);
          logger.info(`[PluginManager] Initialized plugin: ${name}`);
        }
        plugin._enabled = true;
      } catch (error) {
        logger.error(`[PluginManager] Failed to init plugin "${name}":`, error.message);
        plugin._enabled = false;
      }
    }
    this.initialized = true;
  }
  async destroyAll() {
    for (const [name, plugin] of this.plugins) {
      if (!plugin._enabled) continue;
      try {
        if (typeof plugin.destroy === "function") {
          await plugin.destroy();
          logger.info(`[PluginManager] Destroyed plugin: ${name}`);
        }
      } catch (error) {
        logger.error(`[PluginManager] Failed to destroy plugin "${name}":`, error.message);
      }
    }
    this.initialized = false;
  }
  isEnabled(name) {
    const plugin = this.plugins.get(name);
    return plugin && plugin._enabled === true;
  }
  getEnabledPlugins() {
    return Array.from(this.plugins.values()).filter(p => p._enabled).sort((a, b) => {
      const aBuiltin = a._builtin ? 1 : 0;
      const bBuiltin = b._builtin ? 1 : 0;
      if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
      const aPriority = a._priority || 100;
      const bPriority = b._priority || 100;
      return aPriority - bPriority;
    });
  }
  getAuthPlugins() {
    return this.getEnabledPlugins().filter(p => p.type === PLUGIN_TYPE.AUTH && typeof p.authenticate === "function");
  }
  getMiddlewarePlugins() {
    return this.getEnabledPlugins().filter(p => p.type !== PLUGIN_TYPE.AUTH && typeof p.middleware === "function");
  }
  async executeAuth(req, res, requestUrl, config) {
    const authPlugins = this.getAuthPlugins();
    for (const plugin of authPlugins) {
      try {
        const result = await plugin.authenticate(req, res, requestUrl, config);
        if (!result) continue;
        if (result.handled) {
          return {
            handled: true,
            authorized: false
          };
        }
        if (result.authorized === false) {
          return {
            handled: true,
            authorized: false
          };
        }
        if (result.authorized === true) {
          if (result.data) {
            Object.assign(config, result.data);
          }
          return {
            handled: false,
            authorized: true
          };
        }
      } catch (error) {
        logger.error(`[PluginManager] Auth error in plugin "${plugin.name}":`, error.message);
      }
    }
    return {
      handled: false,
      authorized: false
    };
  }
  async executeMiddleware(req, res, requestUrl, config) {
    const middlewarePlugins = this.getMiddlewarePlugins();
    for (const plugin of middlewarePlugins) {
      try {
        const result = await plugin.middleware(req, res, requestUrl, config);
        if (!result) continue;
        if (result.handled) {
          return {
            handled: true
          };
        }
        if (result.data) {
          Object.assign(config, result.data);
        }
      } catch (error) {
        logger.error(`[PluginManager] Middleware error in plugin "${plugin.name}":`, error.message);
      }
    }
    return {
      handled: false
    };
  }
  async executeRoutes(method, path, req, res) {
    for (const plugin of this.getEnabledPlugins()) {
      if (!Array.isArray(plugin.routes)) continue;
      for (const route of plugin.routes) {
        const methodMatch = route.method === "*" || route.method.toUpperCase() === method;
        if (!methodMatch) continue;
        let pathMatch = false;
        if (route.path instanceof RegExp) {
          pathMatch = route.path.test(path);
        } else if (typeof route.path === "string") {
          pathMatch = path === route.path || path.startsWith(route.path + "/");
        }
        if (pathMatch) {
          try {
            const handled = await route.handler(method, path, req, res);
            if (handled) return true;
          } catch (error) {
            logger.error(`[PluginManager] Route error in plugin "${plugin.name}":`, error.message);
          }
        }
      }
    }
    return false;
  }
  getStaticPaths() {
    const paths = [];
    for (const plugin of this.getEnabledPlugins()) {
      if (Array.isArray(plugin.staticPaths)) {
        paths.push(...plugin.staticPaths);
      }
    }
    return paths;
  }
  isPluginStaticPath(path) {
    const staticPaths = this.getStaticPaths();
    return staticPaths.some(sp => path === sp || path === "/" + sp);
  }
  async executeHook(hookName, ...args) {
    for (const plugin of this.getEnabledPlugins()) {
      if (!plugin.hooks || typeof plugin.hooks[hookName] !== "function") continue;
      try {
        await plugin.hooks[hookName](...args);
      } catch (error) {
        logger.error(`[PluginManager] Hook "${hookName}" error in plugin "${plugin.name}":`, error.message);
      }
    }
  }
  getPluginList() {
    const list = [];
    for (const [name, plugin] of this.plugins) {
      const pluginConfig = this.pluginsConfig.plugins[name] || {};
      list.push({
        name: plugin.name,
        version: plugin.version || "1.0.0",
        description: plugin.description || pluginConfig.description || "",
        enabled: plugin._enabled === true,
        hasMiddleware: typeof plugin.middleware === "function",
        hasRoutes: Array.isArray(plugin.routes) && plugin.routes.length > 0,
        hasHooks: plugin.hooks && Object.keys(plugin.hooks).length > 0
      });
    }
    return list;
  }
  async setPluginEnabled(name, enabled) {
    if (!this.pluginsConfig.plugins[name]) {
      this.pluginsConfig.plugins[name] = {};
    }
    this.pluginsConfig.plugins[name].enabled = enabled;
    await this.saveConfig();
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin._enabled = enabled;
    }
  }
}

const pluginManager = new PluginManager;

export async function discoverPlugins() {
  const pluginsDir = path.join(process.cwd(), "src", "plugins");
  try {
    if (!existsSync(pluginsDir)) {
      await fs.mkdir(pluginsDir, {
        recursive: true
      });
      logger.info("[PluginManager] Created plugins directory");
    }
    const entries = await fs.readdir(pluginsDir, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = path.join(pluginsDir, entry.name, "index.js");
      if (!existsSync(pluginPath)) continue;
      try {
        const pluginModule = await import(`file://${pluginPath}`);
        const plugin = pluginModule.default || pluginModule;
        if (plugin && plugin.name) {
          pluginManager.register(plugin);
        }
      } catch (error) {
        logger.error(`[PluginManager] Failed to load plugin from ${entry.name}:`, error.message);
      }
    }
  } catch (error) {
    logger.error("[PluginManager] Failed to discover plugins:", error.message);
  }
}

export function getPluginManager() {
  return pluginManager;
}

export { PluginManager, pluginManager };