import axios from "axios";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import { configureAxiosProxy, configureTLSSidecar } from "../../utils/proxy-utils.js";

import { isRetryableNetworkError, MODEL_PROVIDER } from "../../utils/common.js";

export class ClaudeApiService {
  constructor(config) {
    if (!config.CLAUDE_API_KEY) {
      throw new Error("Claude API Key is required for ClaudeApiService.");
    }
    this.config = config;
    this.apiKey = config.CLAUDE_API_KEY;
    this.baseUrl = config.CLAUDE_BASE_URL;
    this.useSystemProxy = config?.USE_SYSTEM_PROXY_CLAUDE ?? false;
    logger.info(`[Claude] System proxy ${this.useSystemProxy ? "enabled" : "disabled"}`);
    this.client = this.createClient();
  }
  createClient() {
    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    const axiosConfig = {
      baseURL: this.baseUrl,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    };
    if (!this.useSystemProxy) {
      axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.CLAUDE_CUSTOM);
    return axios.create(axiosConfig);
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.CLAUDE_CUSTOM, this.baseUrl);
  }
  async callApi(endpoint, body, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    try {
      const axiosConfig = {
        method: "post",
        url: endpoint,
        data: body
      };
      this._applySidecar(axiosConfig);
      const response = await this.client.request(axiosConfig);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (status === 401 || status === 403) {
        logger.error(`[Claude API] Received ${status}. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Claude API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Claude API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Claude API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      logger.error(`[Claude API] Error calling API (Status: ${status}, Code: ${errorCode}):`, error.message);
      throw error;
    }
  }
  async* streamApi(endpoint, body, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    try {
      const axiosConfig = {
        method: "post",
        url: endpoint,
        data: {
          ...body,
          stream: true
        },
        responseType: "stream"
      };
      this._applySidecar(axiosConfig);
      const response = await this.client.request(axiosConfig);
      const reader = response.data;
      let buffer = "";
      for await (const chunk of reader) {
        buffer += chunk.toString("utf-8");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const eventBlock = buffer.substring(0, boundary);
          buffer = buffer.substring(boundary + 2);
          const lines = eventBlock.split("\n");
          let data = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              data = line.substring(6).trim();
            }
          }
          if (data) {
            try {
              const parsedChunk = JSON.parse(data);
              yield parsedChunk;
              if (parsedChunk.type === "message_stop") {
                return;
              }
            } catch (e) {
              logger.warn("[ClaudeApiService] Failed to parse stream chunk JSON:", e.message, "Data:", data);
            }
          }
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (status === 401 || status === 403) {
        logger.error(`[Claude API] Received ${status} during stream. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Claude API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Claude API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Claude API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      logger.error(`[Claude API] Error generating content stream (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
      throw error;
    }
  }
  async generateContent(model, requestBody) {
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    const response = await this.callApi("/messages", requestBody);
    return response;
  }
  async* generateContentStream(model, requestBody) {
    const stream = this.streamApi("/messages", requestBody);
    for await (const chunk of stream) {
      yield chunk;
    }
  }
  async listModels() {
    logger.info("[ClaudeApiService] Listing available models.");
    const models = [ {
      id: "claude-4-sonnet",
      name: "claude-4-sonnet"
    }, {
      id: "claude-sonnet-4-20250514",
      name: "claude-sonnet-4-20250514"
    }, {
      id: "claude-opus-4-20250514",
      name: "claude-opus-4-20250514"
    }, {
      id: "claude-3-7-sonnet-20250219",
      name: "claude-3-7-sonnet-20250219"
    }, {
      id: "claude-3-5-sonnet-20241022",
      name: "claude-3-5-sonnet-20241022"
    }, {
      id: "claude-3-5-haiku-20241022",
      name: "claude-3-5-haiku-20241022"
    }, {
      id: "claude-3-opus-20240229",
      name: "claude-3-opus-20240229"
    }, {
      id: "claude-3-haiku-20240307",
      name: "claude-3-haiku-20240307"
    } ];
    return {
      models: models.map(m => ({
        name: m.name
      }))
    };
  }
}