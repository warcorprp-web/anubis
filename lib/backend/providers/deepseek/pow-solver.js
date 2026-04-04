import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DeepSeekPOW {
  constructor() {
    this.instance = null;
    this.memory = null;
  }

  async init() {
    const wasmPath = join(__dirname, 'wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm');
    logger.info(`[DeepSeek PoW] Loading WASM from: ${wasmPath}`);
    const wasmBuffer = await readFile(wasmPath);
    logger.info(`[DeepSeek PoW] WASM loaded, size: ${wasmBuffer.length} bytes`);
    const wasmModule = await WebAssembly.compile(wasmBuffer);
    logger.info(`[DeepSeek PoW] WASM compiled`);
    
    this.instance = await WebAssembly.instantiate(wasmModule, {});
    this.memory = this.instance.exports.memory;
    logger.info(`[DeepSeek PoW] WASM instantiated, exports:`, Object.keys(this.instance.exports));
    
    return this;
  }

  _writeToMemory(text) {
    const encoded = Buffer.from(text, 'utf-8');
    const length = encoded.length;
    const ptr = this.instance.exports.__wbindgen_export_0(length, 1);
    
    const memoryView = new Uint8Array(this.memory.buffer);
    for (let i = 0; i < encoded.length; i++) {
      memoryView[ptr + i] = encoded[i];
    }
    
    return [ptr, length];
  }

  calculateHash(algorithm, challenge, salt, difficulty, expireAt) {
    const prefix = `${salt}_${expireAt}_`;
    const retptr = this.instance.exports.__wbindgen_add_to_stack_pointer(-16);
    
    try {
      const [challengePtr, challengeLen] = this._writeToMemory(challenge);
      const [prefixPtr, prefixLen] = this._writeToMemory(prefix);
      
      this.instance.exports.wasm_solve(
        retptr,
        challengePtr,
        challengeLen,
        prefixPtr,
        prefixLen,
        difficulty
      );
      
      const memoryView = new DataView(this.memory.buffer);
      const status = memoryView.getInt32(retptr, true);
      
      if (status === 0) {
        return null;
      }
      
      const value = memoryView.getFloat64(retptr + 8, true);
      return Math.floor(value);
      
    } finally {
      this.instance.exports.__wbindgen_add_to_stack_pointer(16);
    }
  }

  solveChallenge(config) {
    logger.info(`[DeepSeek PoW] Solving challenge:`, config);
    const answer = this.calculateHash(
      config.algorithm,
      config.challenge,
      config.salt,
      config.difficulty,
      config.expire_at
    );
    
    logger.info(`[DeepSeek PoW] Answer: ${answer}`);
    
    const response = {
      algorithm: config.algorithm,
      challenge: config.challenge,
      salt: config.salt,
      answer: answer,
      signature: config.signature,
      target_path: config.target_path
    };
    
    const encoded = Buffer.from(JSON.stringify(response)).toString('base64');
    logger.info(`[DeepSeek PoW] Encoded response: ${encoded}`);
    return encoded;
  }
}
