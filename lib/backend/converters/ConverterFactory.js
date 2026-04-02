import { MODEL_PROTOCOL_PREFIX } from "../utils/common.js";

import logger from "../utils/logger.js";

export class ConverterFactory {
  static #converters=new Map;
  static #converterClasses=new Map;
  static registerConverter(protocolPrefix, ConverterClass) {
    this.#converterClasses.set(protocolPrefix, ConverterClass);
  }
  static getConverter(protocolPrefix) {
    if (this.#converters.has(protocolPrefix)) {
      return this.#converters.get(protocolPrefix);
    }
    const converter = this.createConverter(protocolPrefix);
    if (converter) {
      this.#converters.set(protocolPrefix, converter);
    }
    return converter;
  }
  static createConverter(protocolPrefix) {
    const ConverterClass = this.#converterClasses.get(protocolPrefix);
    if (!ConverterClass) {
      throw new Error(`No converter registered for protocol: ${protocolPrefix}`);
    }
    return new ConverterClass;
  }
  static clearCache() {
    this.#converters.clear();
  }
  static clearConverterCache(protocolPrefix) {
    this.#converters.delete(protocolPrefix);
  }
  static getRegisteredProtocols() {
    return Array.from(this.#converterClasses.keys());
  }
  static isProtocolRegistered(protocolPrefix) {
    return this.#converterClasses.has(protocolPrefix);
  }
}

export class ContentProcessorFactory {
  static #processors=new Map;
  static getProcessor(sourceFormat, targetFormat) {
    const key = `${sourceFormat}_to_${targetFormat}`;
    if (!this.#processors.has(key)) {
      this.#processors.set(key, this.createProcessor(sourceFormat, targetFormat));
    }
    return this.#processors.get(key);
  }
  static createProcessor(sourceFormat, targetFormat) {
    logger.warn(`Content processor for ${sourceFormat} to ${targetFormat} not yet implemented`);
    return null;
  }
  static clearCache() {
    this.#processors.clear();
  }
}

export class ToolProcessorFactory {
  static #processors=new Map;
  static getProcessor(sourceFormat, targetFormat) {
    const key = `${sourceFormat}_to_${targetFormat}`;
    if (!this.#processors.has(key)) {
      this.#processors.set(key, this.createProcessor(sourceFormat, targetFormat));
    }
    return this.#processors.get(key);
  }
  static createProcessor(sourceFormat, targetFormat) {
    logger.warn(`Tool processor for ${sourceFormat} to ${targetFormat} not yet implemented`);
    return null;
  }
  static clearCache() {
    this.#processors.clear();
  }
}

export default ConverterFactory;