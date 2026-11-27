#!/usr/bin/env node
/**
 * 跨平台单端口生产模式启动脚本（Cloud-lite 纯云端精简版）。
 * - 自动构建前端（若 dist 不存在或传入 --build）
 * - 直接启动 @wenjv/server (8787)，无本地 ONNX 模型与 Python Sidecar 依赖
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const IS_WIN = process.platform === 'win32';

function printUsage() {
  console.log(`用法: node scripts/start-prod.mjs [选项]

以单端口生产模式启动问据（wenjv）Cloud-lite 纯云端服务（Windows / macOS / Linux 通用）。

选项:
  --build     强制重新打包 @wenjv/web 前端静态资源后启动
  -h, --help  显示帮助信息`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  let forceBuild = false;
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--build') {
      forceBuild = true;
    } else {
      console.error(`未知参数: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  const baseDir = process.env['WENJV_BASE_DIR'] || path.join(os.homedir(), '.config', 'wenjv');
  const host = process.env['HOST'] || '0.0.0.0';
  const port = process.env['PORT'] || '8787';

  const childEnv = {
    ...process.env,
    NODE_ENV: 'production',
    WENJV_BASE_DIR: baseDir,
    HOST: host,
    PORT: port,
    OCR_ENABLED: process.env['OCR_ENABLED'] || 'false',
  };

  fs.mkdirSync(baseDir, { recursive: true });

  const webDistIndex = path.join(ROOT, 'packages', 'web', 'dist', 'index.html');
  if (forceBuild || !fs.existsSync(webDistIndex)) {
    console.log('正在构建 @wenjv/web 前端静态资源...');
    const buildRes = spawnSync('pnpm', ['--filter', '@wenjv/web', 'build'], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
      shell: IS_WIN,
    });
    if (buildRes.error || buildRes.status !== 0) {
      process.exit(buildRes.status ?? 1);
    }
  }

  console.log(`[wenjv cloud-lite] 正在启动单端口服务 http://${host}:${port} ...`);
  const server = spawn('pnpm', ['--filter', '@wenjv/server', 'start'], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
    shell: IS_WIN,
  });

  const shutdown = (signal) => {
    if (!server.killed) server.kill(signal);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
