#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function removeComments(code) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inBlockComment = false;
  let inLineComment = false;
  
  while (i < code.length) {
    const char = code[i];
    const nextChar = code[i + 1];
    
    // Handle strings
    if (!inBlockComment && !inLineComment) {
      if ((char === '"' || char === "'" || char === '`') && (i === 0 || code[i - 1] !== '\\')) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        result += char;
        i++;
        continue;
      }
    }
    
    // Skip if in string
    if (inString) {
      result += char;
      i++;
      continue;
    }
    
    // Handle block comments
    if (!inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    
    if (inBlockComment && char === '*' && nextChar === '/') {
      inBlockComment = false;
      i += 2;
      continue;
    }
    
    if (inBlockComment) {
      i++;
      continue;
    }
    
    // Handle line comments
    if (!inBlockComment && char === '/' && nextChar === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    
    if (inLineComment && (char === '\n' || char === '\r')) {
      inLineComment = false;
      result += char;
      i++;
      continue;
    }
    
    if (inLineComment) {
      i++;
      continue;
    }
    
    result += char;
    i++;
  }
  
  return result;
}

function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stripped = removeComments(content);
    
    if (content !== stripped) {
      fs.writeFileSync(filePath, stripped, 'utf8');
      console.log(`✅ Processed: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
    return false;
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  let count = 0;
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      if (!['node_modules', '.next', '.git', 'dist', 'build'].includes(file)) {
        count += walkDir(filePath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      if (processFile(filePath)) count++;
    }
  }
  
  return count;
}

console.log('Starting to remove comments from TypeScript files...\n');
const count = walkDir(process.cwd());
console.log(`\n✅ Done! Processed ${count} files.`);
