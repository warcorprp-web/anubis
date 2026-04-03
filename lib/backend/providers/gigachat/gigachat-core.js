import axios from 'axios';
import https from 'https';
import logger from '@/lib/backend/utils/logger';
import fs from 'fs';
import path from 'path';

export class GigaChatApiService {
  constructor(config) {
    // Load credentials from file
    if (config.GIGACHAT_CREDS_FILE_PATH) {
      const credsPath = path.join(process.cwd(), config.GIGACHAT_CREDS_FILE_PATH);
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      this.authKey = creds.authKey;
      this.scope = creds.scope || 'GIGACHAT_API_PERS';
    } else {
      // Fallback to direct config (for backward compatibility)
      this.authKey = config.authKey;
      this.scope = config.scope || 'GIGACHAT_API_PERS';
    }
    
    this.baseUrl = 'https://gigachat.devices.sberbank.ru/api/v1';
    this.authUrl = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
    
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    
    // Ignore self-signed certificate
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });
  }

  async getAccessToken(forceRefresh = false) {
    const now = Date.now();
    
    // Return cached token if still valid (with 5 min buffer)
    if (!forceRefresh && this.accessToken && this.tokenExpiresAt > now + 300000) {
      return this.accessToken;
    }

    logger.info('[GigaChat] Refreshing access token...');

    try {
      const response = await axios.post(
        this.authUrl,
        new URLSearchParams({ scope: this.scope }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'RqUID': this.generateRqUID(),
            'Authorization': `Basic ${this.authKey}`
          },
          httpsAgent: this.httpsAgent
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = response.data.expires_at;
      
      logger.info('[GigaChat] Access token refreshed successfully');
      return this.accessToken;
    } catch (error) {
      logger.error('[GigaChat] Failed to get access token:', error.response?.data || error.message);
      throw error;
    }
  }

  generateRqUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async generateContent(requestBody, isStream = false) {
    const token = await this.getAccessToken();
    const gigachatRequest = this.convertFromOpenAI(requestBody);

    logger.info('[GigaChat] Request:', JSON.stringify(gigachatRequest, null, 2));

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        gigachatRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          httpsAgent: this.httpsAgent,
          responseType: isStream ? 'stream' : 'json'
        }
      );

      if (isStream) {
        return this.handleStream(response.data);
      } else {
        return this.convertToOpenAI(response.data);
      }
    } catch (error) {
      logger.error('[GigaChat] API error:', error.response?.data || error.message);
      throw error;
    }
  }

  convertFromOpenAI(openaiRequest) {
    const gigachatRequest = {
      model: openaiRequest.model || 'GigaChat',
      messages: openaiRequest.messages,
      temperature: openaiRequest.temperature,
      max_tokens: openaiRequest.max_tokens,
      stream: openaiRequest.stream || false
    };

    // Convert tools to functions (GigaChat uses old OpenAI format)
    if (openaiRequest.tools && openaiRequest.tools.length > 0) {
      gigachatRequest.functions = openaiRequest.tools.map(tool => ({
        name: tool.function?.name || tool.name,
        description: tool.function?.description || tool.description,
        parameters: tool.function?.parameters || tool.input_schema || tool.parameters
      }));
    }

    return gigachatRequest;
  }

  convertToOpenAI(gigachatResponse) {
    const choice = gigachatResponse.choices[0];
    const message = choice.message;

    // Convert function_call to tool_calls
    if (message.function_call) {
      message.tool_calls = [{
        id: `call_${Date.now()}`,
        type: 'function',
        function: {
          name: message.function_call.name,
          arguments: JSON.stringify(message.function_call.arguments)
        }
      }];
      delete message.function_call;
    }

    return {
      id: `gigachat-${Date.now()}`,
      object: 'chat.completion',
      created: gigachatResponse.created,
      model: gigachatResponse.model,
      choices: [{
        index: 0,
        message: message,
        finish_reason: choice.finish_reason
      }],
      usage: gigachatResponse.usage
    };
  }

  async *handleStream(stream) {
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield 'data: [DONE]\n\n';
            return;
          }

          try {
            const parsed = JSON.parse(data);
            // Convert to OpenAI format if needed
            yield `data: ${JSON.stringify(parsed)}\n\n`;
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  }
}
