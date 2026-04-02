#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Установка strip-comments если нужно
try {
  require.resolve('strip-comments');
} catch {
  console.log('Installing strip-comments...');
  execSync('npm install --no-save strip-comments', { stdio: 'inherit' });
}

const strip = require('strip-comments');

function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Пропускаем файлы с важными директивами
    if (content.includes("'use client'") || 
        content.includes('"use client"') ||
        content.includes("'use server'") ||
        content.includes('"use server"')) {
      console.log(`⏭️  Skipped (has directives): ${filePath}`);
      return;
    }
    
    const stripped = strip(content, { 
      preserveNewlines: true,
      language: 'javascript'
    });
    
    if (content !== stripped) {
      fs.writeFileSync(filePath, stripped, 'utf8');
      console.log(`✅ Processed: ${filePath}`);
    }
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      if (!['node_modules', '.next', '.git', 'dist', 'build'].includes(file)) {
        walkDir(filePath);
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      processFile(filePath);
    }
  }
}

console.log('Starting to remove comments from TypeScript files...\n');
walkDir(process.cwd());
console.log('\n✅ Done!');
