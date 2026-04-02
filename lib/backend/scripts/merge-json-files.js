import fs from "fs";

import path from "path";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args[0] ? path.resolve(process.cwd(), args[0]) : process.cwd();
  console.log(`[JSON Merger] 扫描目录: ${targetDir}`);
  if (!fs.existsSync(targetDir)) {
    console.error(`错误: 目录不存在 ${targetDir}`);
    process.exit(1);
  }
  try {
    const files = fs.readdirSync(targetDir);
    const jsonFiles = files.filter(file => file.toLowerCase().endsWith(".json"));
    if (jsonFiles.length === 0) {
      console.log("[JSON Merger] 未找到 JSON 文件。");
      process.exit(0);
    }
    console.log(`[JSON Merger] 找到 ${jsonFiles.length} 个 JSON 文件`);
    let mergedData = {};
    let successCount = 0;
    let skipCount = 0;
    for (const file of jsonFiles) {
      const filePath = path.join(targetDir, file);
      if (file.startsWith("merge-kiro-") && file.endsWith("-auth-token.json")) {
        console.log(`[JSON Merger] 跳过之前的合并文件: ${file}`);
        skipCount++;
        continue;
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const jsonData = JSON.parse(content);
        if (typeof jsonData === "object" && jsonData !== null && !Array.isArray(jsonData)) {
          Object.assign(mergedData, jsonData);
          successCount++;
        } else {
          console.log(`[JSON Merger] 文件 ${file} 内容格式不符合要求 (非纯对象)，跳过`);
          skipCount++;
          continue;
        }
      } catch (error) {
        console.warn(`[JSON Merger] 解析文件 ${file} 失败: ${error.message}`);
        skipCount++;
      }
    }
    if (mergedData.clientSecret && mergedData.expiresAt) {
      delete mergedData.expiresAt;
    }
    if (Object.keys(mergedData).length === 0) {
      console.log("[JSON Merger] 没有有效的数据需要合并。");
      process.exit(0);
    }
    const timestamp = Date.now();
    const outputFileName = `merge-kiro-${timestamp}-auth-token.json`;
    const outputFilePath = path.join(__dirname, outputFileName);
    fs.writeFileSync(outputFilePath, JSON.stringify(mergedData, null, 2), "utf-8");
    console.log("");
    console.log("=== 合并完成 ===");
    console.log(`扫描文件数: ${jsonFiles.length}`);
    console.log(`成功处理: ${successCount}`);
    console.log(`跳过/失败: ${skipCount}`);
    console.log(`合并字段数: ${Object.keys(mergedData).length}`);
    console.log(`输出文件: ${outputFilePath}`);
  } catch (error) {
    console.error(`[JSON Merger] 处理过程中发生错误: ${error.message}`);
    process.exit(1);
  }
}

main();