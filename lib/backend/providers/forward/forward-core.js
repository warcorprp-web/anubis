import axios from "axios";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import { configureAxiosProxy, configureTLSSidecar } from "../../utils/proxy-utils.js";

import { isRetryableNetworkError, MODEL_PROVIDER } from "../../utils/common.js";

export class ForwardApiService {
  constructor(config) {
    if (!config.FORWARD_API_KEY) {
      throw new Error("API Key is required for ForwardApiService (FORWARD_API_KEY).");
    }
    if (!config.FORWARD_BASE_URL) {
      throw new Error("Base URL is required for ForwardApiService (FORWARD_BASE_URL).");
    }
    this.config = config;
    this.apiKey = config.FORWARD_API_KEY;
    this.baseUrl = config.FORWARD_BASE_URL;
    this.useSystemProxy = config?.USE_SYSTEM_PROXY_FORWARD ?? false;
    this.headerName = config?.FORWARD_HEADER_NAME || "Authorization";
    this.headerValuePrefix = config?.FORWARD_HEADER_VALUE_PREFIX || "Bearer ";
    logger.info(`[Forward] Base URL: ${this.baseUrl}, System proxy ${this.useSystemProxy ? "enabled" : "disabled"}`);
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
    const headers = {
      "Content-Type": "application/json"
    };
    headers[this.headerName] = `${this.headerValuePrefix}${this.apiKey}`;
    const axiosConfig = {
      baseURL: this.baseUrl,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      headers: headers
    };
    if (!this.useSystemProxy) {
      axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.FORWARD_API);
    this.axiosInstance = axios.create(axiosConfig);
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.FORWARD_API, this.baseUrl);
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
      const response = await this.axiosInstance.request(axiosConfig);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (status === 401 || status === 403) {
        logger.error(`[Forward API] Received ${status}. API Key might be invalid or expired.`);
        throw error;
      }
      if ((status === 429 || status >= 500 && status < 600 || isNetworkError) && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Forward API] Error ${status || errorCode}. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      logger.error(`[Forward API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
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
        data: body,
        responseType: "stream"
      };
      this._applySidecar(axiosConfig);
      const response = await this.axiosInstance.request(axiosConfig);
      const stream = response.data;
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1);
          if (line.startsWith("data: ")) {
            const jsonData = line.substring(6).trim();
            if (jsonData === "[DONE]") {
              return;
            }
            try {
              const parsedChunk = JSON.parse(jsonData);
              yield parsedChunk;
            } catch (e) {
              logger.warn("[ForwardApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
            }
          }
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const isNetworkError = isRetryableNetworkError(error);
      if ((status === 429 || status >= 500 && status < 600 || isNetworkError) && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Forward API] Stream error ${status || errorCode}. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      const errorMessage = error.message || "";
      logger.error(`[Forward API] Error calling streaming API (Status: ${status || errorCode}):`, errorMessage);
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
    const endpoint = requestBody.endpoint || "";
    return this.callApi(endpoint, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    const endpoint = requestBody.endpoint || "";
    yield* this.streamApi(endpoint, requestBody);
  }
  async listModels() {
    try {
      const axiosConfig = {
        method: "get",
        url: "/models"
      };
      this._applySidecar(axiosConfig);
      const response = await this.axiosInstance.request(axiosConfig);
      return response.data;
    } catch (error) {
      logger.error(`Error listing Forward models:`, error.message);
      return {
        data: []
      };
    }
  }
}