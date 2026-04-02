import logger from "../../utils/logger.js";

const aiMonitorPlugin = {
  name: "ai-monitor",
  version: "1.0.0",
  description: "AI 接口监控插件 - 捕获请求和响应参数（全链路协议转换监控，流式聚合输出，用于调试和分析）",
  type: "middleware",
  _priority: 100,
  streamCache: new Map,
  async init(config) {
    logger.info("[AI Monitor Plugin] Initialized");
  },
  async middleware(req, res, requestUrl, config) {
    const aiPaths = [ "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1beta/models" ];
    const isAiPath = aiPaths.some(path => requestUrl.pathname.includes(path));
    if (isAiPath && req.method === "POST") {
      const requestId = Date.now() + Math.random().toString(36).substring(2, 10);
      config._monitorRequestId = requestId;
    }
    return {
      handled: false
    };
  },
  hooks: {
    async onContentGenerated(config) {
      const {originalRequestBody: originalRequestBody, processedRequestBody: processedRequestBody, fromProvider: fromProvider, toProvider: toProvider, model: model, _monitorRequestId: _monitorRequestId, isStream: isStream} = config;
      if (!originalRequestBody) return;
      setImmediate(() => {
        const hasConversion = JSON.stringify(originalRequestBody) !== JSON.stringify(processedRequestBody);
        logger.info(`[AI Monitor][${_monitorRequestId}] >>> Req Protocol: ${fromProvider}${hasConversion ? " -> " + toProvider : ""} | Model: ${model}`);
        if (hasConversion) {
          logger.info(`[AI Monitor][${_monitorRequestId}] [Req Original]: ${JSON.stringify(originalRequestBody)}`);
          logger.info(`[AI Monitor][${_monitorRequestId}] [Req Processed]: ${JSON.stringify(processedRequestBody)}`);
        } else {
          logger.info(`[AI Monitor][${_monitorRequestId}] [Req]: ${JSON.stringify(originalRequestBody)}`);
        }
      });
      if (isStream && _monitorRequestId) {
        setTimeout(() => {
          const cache = aiMonitorPlugin.streamCache.get(_monitorRequestId);
          if (cache) {
            const hasConversion = JSON.stringify(cache.nativeChunks) !== JSON.stringify(cache.convertedChunks);
            logger.info(`[AI Monitor][${_monitorRequestId}] <<< Stream Response Aggregated: ${hasConversion ? cache.toProvider + " -> " : ""}${cache.fromProvider}`);
            if (hasConversion) {
              logger.info(`[AI Monitor][${_monitorRequestId}] [Res Native Full]: ${JSON.stringify(cache.nativeChunks)}`);
              logger.info(`[AI Monitor][${_monitorRequestId}] [Res Converted Full]: ${JSON.stringify(cache.convertedChunks)}`);
            } else {
              logger.info(`[AI Monitor][${_monitorRequestId}] [Res Full]: ${JSON.stringify(cache.nativeChunks)}`);
            }
            aiMonitorPlugin.streamCache.delete(_monitorRequestId);
          }
        }, 2e3);
      }
    },
    async onUnaryResponse({nativeResponse: nativeResponse, clientResponse: clientResponse, fromProvider: fromProvider, toProvider: toProvider, requestId: requestId}) {
      setImmediate(() => {
        const reqId = requestId || "N/A";
        const hasConversion = JSON.stringify(nativeResponse) !== JSON.stringify(clientResponse);
        logger.info(`[AI Monitor][${reqId}] <<< Res Protocol: ${hasConversion ? toProvider + " -> " : ""}${fromProvider} (Unary)`);
        if (hasConversion) {
          logger.info(`[AI Monitor][${reqId}] [Res Native]: ${JSON.stringify(nativeResponse)}`);
          logger.info(`[AI Monitor][${reqId}] [Res Converted]: ${JSON.stringify(clientResponse)}`);
        } else {
          logger.info(`[AI Monitor][${reqId}] [Res]: ${JSON.stringify(nativeResponse)}`);
        }
      });
    },
    async onStreamChunk({nativeChunk: nativeChunk, chunkToSend: chunkToSend, fromProvider: fromProvider, toProvider: toProvider, requestId: requestId}) {
      if (!requestId) return;
      if (!aiMonitorPlugin.streamCache.has(requestId)) {
        aiMonitorPlugin.streamCache.set(requestId, {
          nativeChunks: [],
          convertedChunks: [],
          fromProvider: fromProvider,
          toProvider: toProvider
        });
      }
      const cache = aiMonitorPlugin.streamCache.get(requestId);
      if (nativeChunk != null) {
        if (Array.isArray(nativeChunk)) {
          cache.nativeChunks.push(...nativeChunk.filter(item => item != null));
        } else {
          cache.nativeChunks.push(nativeChunk);
        }
      }
      if (chunkToSend != null) {
        if (Array.isArray(chunkToSend)) {
          cache.convertedChunks.push(...chunkToSend.filter(item => item != null));
        } else {
          cache.convertedChunks.push(chunkToSend);
        }
      }
    },
    async onInternalRequestConverted({requestId: requestId, internalRequest: internalRequest, converterName: converterName}) {
      setImmediate(() => {
        const reqId = requestId || "N/A";
        logger.info(`[AI Monitor][${reqId}] >>> Internal Req Converted [${converterName}]: ${JSON.stringify(internalRequest)}`);
      });
    }
  }
};

export default aiMonitorPlugin;