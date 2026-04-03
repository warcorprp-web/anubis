import { HttpsProxyAgent } from "https-proxy-agent";

import logger from "./logger.js";

import { HttpProxyAgent } from "http-proxy-agent";

import { SocksProxyAgent } from "socks-proxy-agent";

import { getTLSSidecar } from "./tls-sidecar.js";

export function parseProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== "string") {
    return null;
  }
  const trimmedUrl = proxyUrl.trim();
  if (!trimmedUrl) {
    return null;
  }
  try {
    const url = new URL(trimmedUrl);
    const protocol = url.protocol.toLowerCase();
    if (protocol === "socks5:" || protocol === "socks4:" || protocol === "socks:") {
      const socksAgent = new SocksProxyAgent(trimmedUrl, {
        rejectUnauthorized: false  // Allow self-signed certificates through SOCKS proxy
      });
      return {
        httpAgent: socksAgent,
        httpsAgent: socksAgent,
        proxyType: "socks"
      };
    } else if (protocol === "http:" || protocol === "https:") {
      return {
        httpAgent: new HttpProxyAgent(trimmedUrl),
        httpsAgent: new HttpsProxyAgent(trimmedUrl, {
          rejectUnauthorized: false  // Allow self-signed certificates through HTTP proxy
        }),
        proxyType: "http"
      };
    } else {
      logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
      return null;
    }
  } catch (error) {
    logger.error(`[Proxy] Failed to parse proxy URL: ${error.message}`);
    return null;
  }
}

export function isProxyEnabledForProvider(config, providerType) {
  if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
    return false;
  }
  const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
  if (!Array.isArray(enabledProviders)) {
    return false;
  }
  return enabledProviders.includes(providerType);
}

export function getProxyConfigForProvider(config, providerType) {
  if (!isProxyEnabledForProvider(config, providerType)) {
    logger.debug(`[Proxy] Proxy disabled for ${providerType}`);
    return null;
  }
  const proxyConfig = parseProxyUrl(config.PROXY_URL);
  if (proxyConfig) {
    logger.info(`[Proxy] ✓ Using ${proxyConfig.proxyType.toUpperCase()} proxy for ${providerType}: ${config.PROXY_URL}`);
  } else {
    logger.warn(`[Proxy] Failed to configure proxy for ${providerType}: invalid URL ${config.PROXY_URL}`);
  }
  return proxyConfig;
}

export function configureAxiosProxy(axiosConfig, config, providerType) {
  const proxyConfig = getProxyConfigForProvider(config, providerType);
  if (proxyConfig) {
    axiosConfig.httpAgent = proxyConfig.httpAgent;
    axiosConfig.httpsAgent = proxyConfig.httpsAgent;
    axiosConfig.proxy = false;
  }
  return axiosConfig;
}

export function isTLSSidecarEnabledForProvider(config, providerType) {
  if (!config || !config.TLS_SIDECAR_ENABLED || !config.TLS_SIDECAR_ENABLED_PROVIDERS) {
    return false;
  }
  const enabledProviders = config.TLS_SIDECAR_ENABLED_PROVIDERS;
  if (!Array.isArray(enabledProviders)) {
    return false;
  }
  return enabledProviders.includes(providerType);
}

export function configureTLSSidecar(axiosConfig, config, providerType, defaultBaseUrl = null) {
  const sidecar = getTLSSidecar();
  if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
    const proxyUrl = config.TLS_SIDECAR_PROXY_URL || null;
    if (axiosConfig.url && !axiosConfig.url.startsWith("http")) {
      const baseUrl = (axiosConfig.baseURL || defaultBaseUrl || "").replace(/\/$/, "");
      if (baseUrl) {
        const path = axiosConfig.url.startsWith("/") ? axiosConfig.url : "/" + axiosConfig.url;
        axiosConfig.url = baseUrl + path;
      }
    }
    sidecar.wrapAxiosConfig(axiosConfig, proxyUrl);
  }
  return axiosConfig;
}

export function getGoogleAuthProxyConfig(config, providerType) {
  const proxyConfig = getProxyConfigForProvider(config, providerType);
  if (proxyConfig) {
    return {
      agent: proxyConfig.httpsAgent
    };
  }
  return null;
}