import axios from "axios";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import { configureAxiosProxy, configureTLSSidecar } from "../../utils/proxy-utils.js";

import { MODEL_PROVIDER } from "../../utils/common.js";

export class OpenAIResponsesApiService {
  constructor(config) {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OpenAI API Key is required for OpenAIResponsesApiService.");
    }
    this.config = config;
    this.apiKey = config.OPENAI_API_KEY;
    this.baseUrl = config.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
    logger.info(`[OpenAIResponses] System proxy ${this.useSystemProxy ? "enabled" : "disabled"}`);
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
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      }
    };
    if (!this.useSystemProxy) {
      axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES);
    this.axiosInstance = axios.create(axiosConfig);
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, this.baseUrl);
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
      if (status === 401 || status === 403) {
        logger.error(`[API] Received ${status}. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, isRetry, retryCount + 1);
      }
      logger.error(`Error calling OpenAI Responses API (Status: ${status}):`, error.message);
      throw error;
    }
  }
  async* streamApi(endpoint, body, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    const streamRequestBody = {
      ...body,
      stream: true
    };
    try {
      const axiosConfig = {
        method: "post",
        url: endpoint,
        data: streamRequestBody,
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
              logger.warn("[OpenAIResponsesApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
            }
          } else if (line === "") {}
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      if (status === 401 || status === 403) {
        logger.error(`[API] Received ${status} during stream. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
        return;
      }
      logger.error(`Error calling OpenAI Responses streaming API (Status: ${status}):`, error.message);
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
    return this.callApi("/responses", requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    yield* this.streamApi("/responses", requestBody);
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
      const status = error.response?.status;
      const data = error.response?.data;
      logger.error(`Error listing OpenAI Responses models (Status: ${status}):`, data || error.message);
      throw error;
    }
  }
}