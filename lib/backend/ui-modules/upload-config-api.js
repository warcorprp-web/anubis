import { existsSync } from "fs";

import logger from "../utils/logger.js";

import { promises as fs } from "fs";

import path from "path";

import AdmZip from "adm-zip";

import { broadcastEvent } from "./event-broadcast.js";

import { scanConfigFiles } from "./config-scanner.js";

export async function handleGetUploadConfigs(req, res, currentConfig, providerPoolManager) {
  try {
    const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(configFiles));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to scan config files:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to scan config files: " + error.message
      }
    }));
    return true;
  }
}

export async function handleViewConfigFile(req, res, filePath) {
  try {
    const fullPath = path.join(process.cwd(), filePath);
    const allowedDirs = [ "configs" ];
    const relativePath = path.relative(process.cwd(), fullPath);
    const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
    if (!isAllowed) {
      res.writeHead(403, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Access denied: can only view files in configs directory"
        }
      }));
      return true;
    }
    if (!existsSync(fullPath)) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "File does not exist"
        }
      }));
      return true;
    }
    const content = await fs.readFile(fullPath, "utf-8");
    const stats = await fs.stat(fullPath);
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      path: relativePath,
      content: content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      name: path.basename(fullPath)
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to view config file:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to view config file: " + error.message
      }
    }));
    return true;
  }
}

export async function handleDownloadConfigFile(req, res, filePath) {
  try {
    const fullPath = path.join(process.cwd(), filePath);
    const allowedDirs = [ "configs" ];
    const relativePath = path.relative(process.cwd(), fullPath);
    const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
    if (!isAllowed) {
      res.writeHead(403, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Access denied: can only download files in configs directory"
        }
      }));
      return true;
    }
    if (!existsSync(fullPath)) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "File does not exist"
        }
      }));
      return true;
    }
    const content = await fs.readFile(fullPath);
    const fileName = path.basename(fullPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": content.length
    });
    res.end(content);
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to download config file:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to download config file: " + error.message
      }
    }));
    return true;
  }
}

export async function handleDeleteConfigFile(req, res, filePath) {
  try {
    const fullPath = path.join(process.cwd(), filePath);
    const allowedDirs = [ "configs" ];
    const relativePath = path.relative(process.cwd(), fullPath);
    const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
    if (!isAllowed) {
      res.writeHead(403, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Access denied: can only delete files in configs directory"
        }
      }));
      return true;
    }
    if (!existsSync(fullPath)) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "File does not exist"
        }
      }));
      return true;
    }
    await fs.unlink(fullPath);
    broadcastEvent("config_update", {
      action: "delete",
      filePath: relativePath,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: "File deleted successfully",
      filePath: relativePath
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to delete config file:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to delete config file: " + error.message
      }
    }));
    return true;
  }
}

export async function handleDownloadAllConfigs(req, res) {
  try {
    const configsPath = path.join(process.cwd(), "configs");
    if (!existsSync(configsPath)) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "configs directory does not exist"
        }
      }));
      return true;
    }
    const zip = new AdmZip;
    const addDirectoryToZip = async (dirPath, zipPath = "") => {
      const items = await fs.readdir(dirPath, {
        withFileTypes: true
      });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
        if (item.isFile()) {
          const content = await fs.readFile(fullPath);
          zip.addFile(itemZipPath.replace(/\\/g, "/"), content);
        } else if (item.isDirectory()) {
          await addDirectoryToZip(fullPath, itemZipPath);
        }
      }
    };
    await addDirectoryToZip(configsPath);
    const zipBuffer = zip.toBuffer();
    const filename = `configs_backup_${(new Date).toISOString().replace(/[:.]/g, "-")}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": zipBuffer.length
    });
    res.end(zipBuffer);
    logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to download all configs:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to download zip: " + error.message
      }
    }));
    return true;
  }
}

export async function handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager) {
  try {
    const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
    const unboundConfigs = configFiles.filter(config => {
      if (config.isUsed) return false;
      const normalizedPath = config.path.replace(/\\/g, "/");
      const pathParts = normalizedPath.split("/");
      if (pathParts.length >= 3 && pathParts[0] === "configs") {
        return true;
      }
      return false;
    });
    if (unboundConfigs.length === 0) {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "No unbound config files to delete",
        deletedCount: 0,
        deletedFiles: []
      }));
      return true;
    }
    const deletedFiles = [];
    const failedFiles = [];
    for (const config of unboundConfigs) {
      try {
        const fullPath = path.join(process.cwd(), config.path);
        const allowedDirs = [ "configs" ];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        if (!isAllowed) {
          failedFiles.push({
            path: config.path,
            error: "Access denied: can only delete files in configs directory"
          });
          continue;
        }
        if (!existsSync(fullPath)) {
          failedFiles.push({
            path: config.path,
            error: "File does not exist"
          });
          continue;
        }
        await fs.unlink(fullPath);
        deletedFiles.push(config.path);
      } catch (error) {
        failedFiles.push({
          path: config.path,
          error: error.message
        });
      }
    }
    if (deletedFiles.length > 0) {
      broadcastEvent("config_update", {
        action: "batch_delete",
        deletedFiles: deletedFiles,
        timestamp: (new Date).toISOString()
      });
    }
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Deleted ${deletedFiles.length} unbound config files`,
      deletedCount: deletedFiles.length,
      deletedFiles: deletedFiles,
      failedCount: failedFiles.length,
      failedFiles: failedFiles
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to delete unbound configs:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to delete unbound configs: " + error.message
      }
    }));
    return true;
  }
}