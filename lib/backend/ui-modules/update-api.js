import { existsSync, readFileSync, writeFileSync } from "fs";

import logger from "../utils/logger.js";

import { promises as fs } from "fs";

import path from "path";

import { exec } from "child_process";

import { promisify } from "util";

import { CONFIG } from "../core/config-adapter";

import { parseProxyUrl } from "../utils/proxy-utils.js";

const execAsync = promisify(exec);

const GITHUB_REPO = "justlovemaki/AIClient-2-API";

function buildGitHubApiCandidates(repo) {
  const apiPath = `repos/${repo}/tags`;
  return [ {
    name: "gh-proxy.org",
    url: `https://gh-proxy.org/https://api.github.com/${apiPath}`
  }, {
    name: "hk.gh-proxy.org",
    url: `https://hk.gh-proxy.org/https://api.github.com/${apiPath}`
  }, {
    name: "cdn.gh-proxy.org",
    url: `https://cdn.gh-proxy.org/https://api.github.com/${apiPath}`
  }, {
    name: "edgeone.gh-proxy.org",
    url: `https://edgeone.gh-proxy.org/https://api.github.com/${apiPath}`
  }, {
    name: "github-direct",
    url: `https://api.github.com/${apiPath}`
  } ];
}

function buildTarballCandidates(repo, tag) {
  const githubTarballPath = `${repo}/archive/refs/tags/${tag}.tar.gz`;
  return [ {
    name: "gh-proxy.org",
    url: `https://gh-proxy.org/https://github.com/${githubTarballPath}`
  }, {
    name: "hk.gh-proxy.org",
    url: `https://hk.gh-proxy.org/https://github.com/${githubTarballPath}`
  }, {
    name: "cdn.gh-proxy.org",
    url: `https://cdn.gh-proxy.org/https://github.com/${githubTarballPath}`
  }, {
    name: "edgeone.gh-proxy.org",
    url: `https://edgeone.gh-proxy.org/https://github.com/${githubTarballPath}`
  }, {
    name: "gitclone.com",
    url: `https://gitclone.com/github.com/${githubTarballPath}`
  } ];
}

function getUpdateProxyConfig() {
  if (!CONFIG || !CONFIG.PROXY_URL) {
    return null;
  }
  const proxyConfig = parseProxyUrl(CONFIG.PROXY_URL);
  if (proxyConfig) {
    logger.info(`[Update] Using ${proxyConfig.proxyType} proxy for update check: ${CONFIG.PROXY_URL}`);
  }
  return proxyConfig;
}

async function fetchWithProxy(url, options = {}) {
  const proxyConfig = getUpdateProxyConfig();
  if (proxyConfig) {
    const fetchOptions = {
      ...options,
      dispatcher: undefined
    };
    const urlObj = new URL(url);
    if (urlObj.protocol === "https:") {
      fetchOptions.agent = proxyConfig.httpsAgent;
    } else {
      fetchOptions.agent = proxyConfig.httpAgent;
    }
    try {
      const {fetch: undiciFetch, ProxyAgent: ProxyAgent} = await import("undici");
      const proxyAgent = new ProxyAgent(CONFIG.PROXY_URL);
      return await undiciFetch(url, {
        ...options,
        dispatcher: proxyAgent
      });
    } catch (importError) {
      logger.warn("[Update] undici not available, falling back to native fetch without proxy");
      return await fetch(url, options);
    }
  }
  return await fetch(url, options);
}

function compareVersions(v1, v2) {
  const clean1 = v1.replace(/^v/, "");
  const clean2 = v2.replace(/^v/, "");
  const parts1 = clean1.split(".").map(Number);
  const parts2 = clean2.split(".").map(Number);
  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

async function getLatestVersionFromGitHub() {
  const candidates = buildGitHubApiCandidates(GITHUB_REPO);
  for (const candidate of candidates) {
    try {
      logger.info(`[Update] Fetching latest version from GitHub API via ${candidate.name}...`);
      logger.info(`[Update] Request URL: ${candidate.url}`);
      const response = await fetchWithProxy(candidate.url, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "AIClient2API-UpdateChecker"
        },
        timeout: 1e4
      });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
      }
      const tags = await response.json();
      if (!Array.isArray(tags) || tags.length === 0) {
        logger.warn(`[Update] No tags returned via ${candidate.name}`);
        continue;
      }
      const versions = tags.map(tag => tag.name).filter(name => /^v?\d+\.\d+/.test(name));
      if (versions.length === 0) {
        logger.warn(`[Update] No valid version tags found via ${candidate.name}`);
        continue;
      }
      versions.sort((a, b) => compareVersions(b, a));
      logger.info(`[Update] Latest version fetched successfully via ${candidate.name}: ${versions[0]}`);
      return versions[0];
    } catch (error) {
      logger.warn(`[Update] Failed to fetch latest version via ${candidate.name}: ${error.message}`);
    }
  }
  logger.warn("[Update] All GitHub API proxy attempts failed");
  return null;
}

export async function checkForUpdates() {
  const versionFilePath = path.join(process.cwd(), "VERSION");
  let localVersion = "unknown";
  try {
    if (existsSync(versionFilePath)) {
      localVersion = readFileSync(versionFilePath, "utf-8").trim();
    }
  } catch (error) {
    logger.warn("[Update] Failed to read local VERSION file:", error.message);
  }
  let isGitRepo = false;
  try {
    await execAsync("git rev-parse --git-dir");
    isGitRepo = true;
  } catch (error) {
    isGitRepo = false;
    logger.info("[Update] Not in a Git repository, will use GitHub API to check for updates");
  }
  let latestTag = null;
  let updateMethod = "unknown";
  if (isGitRepo) {
    updateMethod = "git";
    try {
      logger.info("[Update] Fetching remote tags...");
      await execAsync("git fetch --tags");
    } catch (error) {
      logger.warn("[Update] Failed to fetch tags via git, falling back to GitHub API:", error.message);
      latestTag = await getLatestVersionFromGitHub();
      updateMethod = "github_api";
    }
    if (!latestTag && updateMethod === "git") {
      const isWindows = process.platform === "win32";
      try {
        if (isWindows) {
          const {stdout: stdout} = await execAsync('git for-each-ref --sort=-v:refname --format="%(refname:short)" refs/tags --count=1');
          latestTag = stdout.trim();
        } else {
          const {stdout: stdout} = await execAsync("git tag --sort=-v:refname | head -n 1");
          latestTag = stdout.trim();
        }
      } catch (error) {
        try {
          const {stdout: stdout} = await execAsync("git tag");
          const tags = stdout.trim().split("\n").filter(t => t);
          if (tags.length > 0) {
            tags.sort((a, b) => compareVersions(b, a));
            latestTag = tags[0];
          }
        } catch (e) {
          logger.warn("[Update] Failed to get latest tag via git, falling back to GitHub API:", e.message);
          latestTag = await getLatestVersionFromGitHub();
          updateMethod = "github_api";
        }
      }
    }
  } else {
    updateMethod = "github_api";
    latestTag = await getLatestVersionFromGitHub();
  }
  if (!latestTag) {
    return {
      hasUpdate: false,
      localVersion: localVersion,
      latestVersion: null,
      updateMethod: updateMethod,
      error: "Unable to get latest version information"
    };
  }
  const comparison = compareVersions(latestTag, localVersion);
  const hasUpdate = comparison > 0;
  logger.info(`[Update] Local version: ${localVersion}, Latest version: ${latestTag}, Has update: ${hasUpdate}, Method: ${updateMethod}`);
  return {
    hasUpdate: hasUpdate,
    localVersion: localVersion,
    latestVersion: latestTag,
    updateMethod: updateMethod,
    error: null
  };
}

export async function performUpdate() {
  const updateInfo = await checkForUpdates();
  if (updateInfo.error) {
    throw new Error(updateInfo.error);
  }
  if (!updateInfo.hasUpdate) {
    return {
      success: true,
      message: "Already at the latest version",
      localVersion: updateInfo.localVersion,
      latestVersion: updateInfo.latestVersion,
      updated: false
    };
  }
  const latestTag = updateInfo.latestVersion;
  if (updateInfo.updateMethod === "github_api") {
    logger.info("[Update] Running in Docker/non-Git environment, will download and extract tarball");
    return await performTarballUpdate(updateInfo.localVersion, latestTag);
  }
  logger.info(`[Update] Starting update to ${latestTag}...`);
  try {
    const {stdout: statusOutput} = await execAsync("git status --porcelain");
    if (statusOutput.trim()) {
      logger.info("[Update] Stashing local changes...");
      await execAsync("git stash");
    }
  } catch (error) {
    logger.warn("[Update] Failed to check git status:", error.message);
  }
  try {
    logger.info(`[Update] Checking out to ${latestTag}...`);
    await execAsync(`git checkout ${latestTag}`);
  } catch (error) {
    logger.error("[Update] Failed to checkout:", error.message);
    throw new Error("Failed to switch to new version: " + error.message);
  }
  const versionFilePath = path.join(process.cwd(), "VERSION");
  try {
    const newVersion = latestTag.replace(/^v/, "");
    writeFileSync(versionFilePath, newVersion, "utf-8");
    logger.info(`[Update] VERSION file updated to ${newVersion}`);
  } catch (error) {
    logger.warn("[Update] Failed to update VERSION file:", error.message);
  }
  let needsRestart = false;
  try {
    const localVersionTag = updateInfo.localVersion.startsWith("v") ? updateInfo.localVersion : `v${updateInfo.localVersion}`;
    const {stdout: diffOutput} = await execAsync(`git diff ${localVersionTag}..${latestTag} --name-only`);
    if (diffOutput.includes("package.json") || diffOutput.includes("package-lock.json")) {
      logger.info("[Update] package.json changed, running npm install...");
      await execAsync("npm install");
      needsRestart = true;
    }
  } catch (error) {
    logger.warn("[Update] Failed to check package changes:", error.message);
  }
  logger.info(`[Update] Update completed successfully to ${latestTag}`);
  return {
    success: true,
    message: `Successfully updated to version ${latestTag}`,
    localVersion: updateInfo.localVersion,
    latestVersion: latestTag,
    updated: true,
    updateMethod: "git",
    needsRestart: needsRestart,
    restartMessage: needsRestart ? "Dependencies updated, recommend restarting service to apply changes" : null
  };
}

async function performTarballUpdate(localVersion, latestTag) {
  const tarballCandidates = buildTarballCandidates(GITHUB_REPO, latestTag);
  const appDir = process.cwd();
  const tempDir = path.join(appDir, ".update_temp");
  const tarballPath = path.join(tempDir, "update.tar.gz");
  logger.info(`[Update] Starting tarball update to ${latestTag}...`);
  try {
    await fs.mkdir(tempDir, {
      recursive: true
    });
    logger.info("[Update] Created temp directory");
    logger.info("[Update] Downloading tarball via proxy candidates...");
    let downloadSucceeded = false;
    let lastDownloadError = null;
    for (const candidate of tarballCandidates) {
      try {
        logger.info(`[Update] Trying tarball download via ${candidate.name}: ${candidate.url}`);
        logger.info(`[Update] Request URL: ${candidate.url}`);
        const response = await fetchWithProxy(candidate.url, {
          headers: {
            "User-Agent": "AIClient2API-Updater"
          },
          redirect: "follow"
        });
        if (!response.ok) {
          throw new Error(`Failed to download tarball: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        await fs.writeFile(tarballPath, buffer);
        logger.info(`[Update] Downloaded tarball via ${candidate.name} (${buffer.length} bytes)`);
        downloadSucceeded = true;
        break;
      } catch (downloadError) {
        lastDownloadError = downloadError;
        logger.warn(`[Update] Tarball download failed via ${candidate.name}: ${downloadError.message}`);
      }
    }
    if (!downloadSucceeded) {
      throw new Error(`All tarball proxy attempts failed${lastDownloadError ? `: ${lastDownloadError.message}` : ""}`);
    }
    logger.info("[Update] Extracting tarball...");
    await execAsync(`tar -xzf "${tarballPath}" -C "${tempDir}"`);
    const extractedItems = await fs.readdir(tempDir);
    const extractedDir = extractedItems.find(item => item.startsWith("AIClient-2-API-") || item.startsWith("AIClient2API-"));
    if (!extractedDir) {
      throw new Error("Could not find extracted directory");
    }
    const sourcePath = path.join(tempDir, extractedDir);
    logger.info(`[Update] Extracted to: ${sourcePath}`);
    const oldPackageJson = existsSync(path.join(appDir, "package.json")) ? readFileSync(path.join(appDir, "package.json"), "utf-8") : null;
    const dirsToClean = [ "src", "static" ];
    for (const dirName of dirsToClean) {
      const dirPath = path.join(appDir, dirName);
      if (existsSync(dirPath)) {
        logger.info(`[Update] Removing old ${dirName}/ directory before extraction...`);
        await fs.rm(dirPath, {
          recursive: true,
          force: true
        });
        logger.info(`[Update] Old ${dirName}/ directory removed`);
      }
    }
    const preservePaths = [ "configs", "node_modules", ".update_temp", "logs", "tls-sidecar" ];
    logger.info("[Update] Copying new files...");
    const sourceItems = await fs.readdir(sourcePath);
    for (const item of sourceItems) {
      if (preservePaths.includes(item)) {
        logger.info(`[Update] Skipping preserved path: ${item}`);
        continue;
      }
      const srcItemPath = path.join(sourcePath, item);
      const destItemPath = path.join(appDir, item);
      if (existsSync(destItemPath)) {
        const stat = await fs.stat(destItemPath);
        if (stat.isDirectory()) {
          await fs.rm(destItemPath, {
            recursive: true,
            force: true
          });
        } else {
          await fs.unlink(destItemPath);
        }
      }
      await copyRecursive(srcItemPath, destItemPath);
      logger.info(`[Update] Copied: ${item}`);
    }
    let needsRestart = true;
    let needsNpmInstall = false;
    if (oldPackageJson) {
      const newPackageJson = readFileSync(path.join(appDir, "package.json"), "utf-8");
      if (oldPackageJson !== newPackageJson) {
        logger.info("[Update] package.json changed, running npm install...");
        needsNpmInstall = true;
        try {
          await execAsync("npm install", {
            cwd: appDir
          });
          logger.info("[Update] npm install completed");
        } catch (npmError) {
          logger.error("[Update] npm install failed:", npmError.message);
        }
      }
    }
    logger.info("[Update] Cleaning up...");
    await fs.rm(tempDir, {
      recursive: true,
      force: true
    });
    logger.info(`[Update] Tarball update completed successfully to ${latestTag}`);
    return {
      success: true,
      message: `Successfully updated to version ${latestTag}`,
      localVersion: localVersion,
      latestVersion: latestTag,
      updated: true,
      updateMethod: "tarball",
      needsRestart: needsRestart,
      needsNpmInstall: needsNpmInstall,
      restartMessage: "Code updated, please restart the service to apply changes"
    };
  } catch (error) {
    try {
      if (existsSync(tempDir)) {
        await fs.rm(tempDir, {
          recursive: true,
          force: true
        });
      }
    } catch (cleanupError) {
      logger.warn("[Update] Failed to cleanup temp directory:", cleanupError.message);
    }
    logger.error("[Update] Tarball update failed:", error.message);
    throw new Error(`Tarball update failed: ${error.message}`);
  }
}

async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, {
      recursive: true
    });
    const items = await fs.readdir(src);
    for (const item of items) {
      await copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

export async function handleCheckUpdate(req, res) {
  try {
    const updateInfo = await checkForUpdates();
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(updateInfo));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to check for updates:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to check for updates: " + error.message
      }
    }));
    return true;
  }
}

export async function handlePerformUpdate(req, res) {
  try {
    const updateResult = await performUpdate();
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(updateResult));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to perform update:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Update failed: " + error.message
      }
    }));
    return true;
  }
}