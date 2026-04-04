import axios from 'axios';
import { DeepSeekPOW } from './pow-solver.js';
import logger from '../../utils/logger.js';
import { getProxyConfigForProvider } from '../../utils/proxy-utils.js';

export class DeepSeekProvider {
  constructor(config) {
    this.config = config;
    this.baseURL = 'https://chat.deepseek.com/api/v0';
    this.authToken = config.authToken;
    this.powSolver = null;
    this.sessionId = null;
  }

  async init() {
    this.powSolver = await new DeepSeekPOW().init();
    return this;
  }

  async createSession() {
    const proxyConfig = getProxyConfigForProvider(this.config, 'deepseek');
    const axiosConfig = {
      headers: {
        'authorization': `Bearer ${this.authToken}`,
        'content-type': 'application/json'
      }
    };
    
    if (proxyConfig?.httpsAgent) {
      axiosConfig.httpsAgent = proxyConfig.httpsAgent;
      axiosConfig.httpAgent = proxyConfig.httpAgent;
    }

    const response = await axios.post(
      `${this.baseURL}/chat_session/create`,
      { character_id: null },
      axiosConfig
    );
    
    this.sessionId = response.data.data.biz_data.id;
    logger.info(`[DeepSeek] Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  async getPowChallenge() {
    const proxyConfig = getProxyConfigForProvider(this.config, 'deepseek');
    const axiosConfig = {
      headers: {
        'authorization': `Bearer ${this.authToken}`,
        'content-type': 'application/json'
      }
    };
    
    if (proxyConfig?.httpsAgent) {
      axiosConfig.httpsAgent = proxyConfig.httpsAgent;
      axiosConfig.httpAgent = proxyConfig.httpAgent;
    }

    const response = await axios.post(
      `${this.baseURL}/chat/create_pow_challenge`,
      { target_path: '/api/v0/chat/completion' },
      axiosConfig
    );
    
    return response.data.data.biz_data.challenge;
  }

  async *chatCompletion(messages, options = {}) {
    if (!this.sessionId) {
      await this.createSession();
    }

    const challenge = await this.getPowChallenge();
    const powResponse = this.powSolver.solveChallenge(challenge);

    const proxyConfig = getProxyConfigForProvider(this.config, 'deepseek');
    const axiosConfig = {
      headers: {
        'authorization': `Bearer ${this.authToken}`,
        'content-type': 'application/json',
        'x-ds-pow-response': powResponse
      },
      responseType: 'stream'
    };
    
    if (proxyConfig?.httpsAgent) {
      axiosConfig.httpsAgent = proxyConfig.httpsAgent;
      axiosConfig.httpAgent = proxyConfig.httpAgent;
    }

    const prompt = messages[messages.length - 1].content;
    
    logger.info(`[DeepSeek] Sending request to ${this.baseURL}/chat/completion`);
    const response = await axios.post(
      `${this.baseURL}/chat/completion`,
      {
        chat_session_id: this.sessionId,
        parent_message_id: null,
        prompt: prompt,
        ref_file_ids: [],
        search_enabled: false,
        thinking_enabled: options.thinking || false,
        preempt: false
      },
      axiosConfig
    );

    logger.info(`[DeepSeek] Response received, processing stream...`);
    
    // Collect all data first
    const allData = await new Promise((resolve, reject) => {
      let buffer = '';
      const chunks = [];
      let dataReceived = false;
      
      response.data.on('data', (chunk) => {
        dataReceived = true;
        const chunkStr = chunk.toString();
        logger.info(`[DeepSeek] Raw chunk (${chunkStr.length} bytes): ${chunkStr.substring(0, 500)}`);
        buffer += chunkStr;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        
        for (const line of lines) {
          logger.debug(`[DeepSeek] Processing line: ${line.substring(0, 200)}`);
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6);
              logger.debug(`[DeepSeek] Parsing JSON: ${jsonStr.substring(0, 200)}`);
              const data = JSON.parse(jsonStr);
              logger.info(`[DeepSeek] Parsed data:`, JSON.stringify(data));
              if (data.v && typeof data.v === 'string' && data.v !== 'FINISHED') {
                logger.info(`[DeepSeek] Adding chunk with content: ${data.v}`);
                chunks.push({
                  choices: [{
                    delta: { content: data.v },
                    index: 0,
                    finish_reason: null
                  }]
                });
              }
            } catch (e) {
              logger.warn(`[DeepSeek] Failed to parse line: ${line.substring(0, 100)}`, e.message);
            }
          }
        }
      });
      
      response.data.on('end', () => {
        logger.info(`[DeepSeek] Stream ended, collected ${chunks.length} chunks, dataReceived: ${dataReceived}`);
        resolve(chunks);
      });
      
      response.data.on('error', (err) => {
        logger.error(`[DeepSeek] Stream error:`, err);
        reject(err);
      });
    });
    
    // Yield all collected chunks
    for (const chunk of allData) {
      yield chunk;
    }
  }
}
