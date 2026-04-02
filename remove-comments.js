const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

async function removeComments(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const result = await minify(code, {
    compress: false,
    mangle: false,
    format: {
      comments: false,
      beautify: true,
      indent_level: 2
    }
  });
  fs.writeFileSync(filePath, result.code);
}

async function processDirectory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      await processDirectory(fullPath);
    } else if (file.name.endsWith('.js')) {
      console.log(`Processing: ${fullPath}`);
      await removeComments(fullPath);
    }
  }
}

processDirectory('./lib/backend').then(() => {
  console.log('✅ Done');
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
