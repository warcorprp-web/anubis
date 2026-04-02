import { NextRequest, NextResponse } from 'next/server';
import os from 'os';

export async function GET(request: NextRequest) {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);
    
    const cpus = os.cpus();
    const cpuUsage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    return NextResponse.json({
      memory: `${memUsagePercent}%`,
      cpu: `${cpuUsage.toFixed(1)}%`,
      uptime: `${hours}ч ${minutes}м`,
      serverTime: new Date().toLocaleString('ru-RU'),
    });
  } catch (error) {
    return NextResponse.json(
      { error: { message: 'Ошибка получения системной информации', code: 'SYSTEM_ERROR' } },
      { status: 500 }
    );
  }
}
