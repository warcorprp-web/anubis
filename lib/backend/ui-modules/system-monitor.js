import os from "os";

import { execSync } from "child_process";

let previousCpuInfo = null;

const processCpuInfoMap = new Map;

export function getSystemCpuUsagePercent() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const currentCpuInfo = {
    idle: totalIdle,
    total: totalTick
  };
  let cpuPercent = 0;
  if (previousCpuInfo) {
    const idleDiff = currentCpuInfo.idle - previousCpuInfo.idle;
    const totalDiff = currentCpuInfo.total - previousCpuInfo.total;
    if (totalDiff > 0) {
      cpuPercent = 100 - 100 * idleDiff / totalDiff;
    }
  }
  previousCpuInfo = currentCpuInfo;
  return `${cpuPercent.toFixed(1)}%`;
}

export function getProcessCpuUsagePercent(pid) {
  if (!pid) return "0.0%";
  try {
    const isWindows = process.platform === "win32";
    let cpuPercent = 0;
    if (pid === process.pid) {
      const usage = process.cpuUsage();
      const timestamp = Date.now();
      const totalMicroseconds = usage.user + usage.system;
      const prevInfo = processCpuInfoMap.get(pid);
      if (prevInfo && prevInfo.totalMicroseconds !== undefined) {
        const timeDiff = (timestamp - prevInfo.timestamp) * 1e3;
        const processTimeDiff = totalMicroseconds - prevInfo.totalMicroseconds;
        if (timeDiff > 0) {
          const cpuCount = os.cpus().length;
          cpuPercent = processTimeDiff / timeDiff * 100;
          cpuPercent = cpuPercent / cpuCount;
        }
      }
      processCpuInfoMap.set(pid, {
        totalMicroseconds: totalMicroseconds,
        timestamp: timestamp
      });
    } else if (isWindows) {
      const command = `powershell -Command "Get-Process -Id ${pid} | Select-Object -ExpandProperty TotalProcessorTime | ForEach-Object { $_.TotalSeconds }"`;
      const output = execSync(command, {
        encoding: "utf8"
      }).trim();
      const totalProcessorSeconds = parseFloat(output);
      const timestamp = Date.now();
      if (!isNaN(totalProcessorSeconds)) {
        const prevInfo = processCpuInfoMap.get(pid);
        if (prevInfo && prevInfo.totalProcessorSeconds !== undefined) {
          const timeDiff = (timestamp - prevInfo.timestamp) / 1e3;
          const processTimeDiff = totalProcessorSeconds - prevInfo.totalProcessorSeconds;
          if (timeDiff > 0) {
            const cpuCount = os.cpus().length;
            cpuPercent = processTimeDiff / timeDiff * 100;
            cpuPercent = cpuPercent / cpuCount;
          }
        }
        processCpuInfoMap.set(pid, {
          totalProcessorSeconds: totalProcessorSeconds,
          timestamp: timestamp
        });
      }
    } else {
      try {
        const output = execSync(`ps -p ${pid} -o %cpu 2>/dev/null`, {
          encoding: "utf8"
        });
        const lines = output.trim().split("\n");
        if (lines.length >= 2) {
          cpuPercent = parseFloat(lines[1].trim());
        }
      } catch (e) {
        cpuPercent = 0;
      }
    }
    return `${Math.max(0, cpuPercent).toFixed(1)}%`;
  } catch (error) {
    return "0.0%";
  }
}

export function getCpuUsagePercent(pid) {
  if (pid) {
    return getProcessCpuUsagePercent(pid);
  }
  return getSystemCpuUsagePercent();
}