#!/usr/bin/env node
/**
 * 跨平台单端口生产模式启动脚本（Windows / macOS / Linux 通用）。
 * - 自动构建前端（若 dist 不存在或传入 --build）
 * - 检测本地 ONNX 模型，缺失时引导或自动运行 download-models.mjs
 * - 自动拉起 Python OCR Sidecar (8788，若已安装) 与 @wenjv/server (8787)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isModelReady, OCR_MODELS, RETRIEVAL_MODELS } from './download-models.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const IS_WIN = process.platform === 'win32';

function printUsage() {
  console.log(`用法: node scripts/start-prod.mjs [选项]

以单端口生产模式启动问据（wenjv）全栈服务（Windows / macOS / Linux 通用）。

选项:
  --build     强制重新打包 @wenjv/web 前端静态资源后启动
  -h, --help  显示帮助信息`);
}

async function promptYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
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
  const modelsDir = path.resolve(process.env['MODELS_DIR'] || path.resolve(REPO_ROOT, 'models'));

  const childEnv = {
    ...process.env,
    NODE_ENV: 'production',
    WENJV_BASE_DIR: baseDir,
    HOST: host,
    PORT: port,
    MODELS_DIR: modelsDir,
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

  const sidecarDir = path.join(ROOT, 'sidecar');
  const sidecarPython = IS_WIN
    ? path.join(sidecarDir, '.venv', 'Scripts', 'python.exe')
    : path.join(sidecarDir, '.venv', 'bin', 'python');
  const hasSidecar = process.env['OCR_ENABLED'] !== 'false' && fs.existsSync(sidecarPython);

  const requiredModels = hasSidecar
    ? [...RETRIEVAL_MODELS, ...OCR_MODELS]
    : [...RETRIEVAL_MODELS];
  const modelsMissing = requiredModels.some((name) => !isModelReady(modelsDir, name));

  if (modelsMissing) {
    const downloaderPath = path.join(SCRIPT_DIR, 'download-models.mjs');
    const dlArgs = hasSidecar
      ? [downloaderPath, '--dir', modelsDir]
      : [downloaderPath, '--dir', modelsDir, '--no-ocr'];
    const sizeHint = hasSidecar ? '约 1.1 GB' : '约 840 MB';

    if (process.env['WENJV_AUTO_DOWNLOAD_MODELS'] === 'true') {
      console.log(`检测到本地模型不完整，正在自动下载至：${modelsDir} ...`);
      const dlRes = spawnSync(process.execPath, dlArgs, {
        cwd: ROOT,
        env: childEnv,
        stdio: 'inherit',
      });
      if (dlRes.status !== 0) process.exit(dlRes.status ?? 1);
    } else if (process.stdin.isTTY) {
      const confirmed = await promptYesNo(
        `未检测到完整本地模型（目录：${modelsDir}），是否现在一键下载（${sizeHint}）？[Y/n] `
      );
      if (confirmed) {
        const dlRes = spawnSync(process.execPath, dlArgs, {
          cwd: ROOT,
          env: childEnv,
          stdio: 'inherit',
        });
        if (dlRes.status !== 0) process.exit(dlRes.status ?? 1);
      } else {
        console.log('已跳过模型下载；如需本地检索与 OCR，稍后可运行 pnpm run download-models。');
      }
    } else {
      console.log(`警告：未检测到完整本地模型（${modelsDir}），请先运行 pnpm run download-models。`);
    }
  }

  console.log('=============================================');
  console.log('  问据 wenjv 生产服务启动 (单端口模式)');
  console.log(`  数据目录: ${baseDir}`);
  console.log(`  模型目录: ${modelsDir}`);
  console.log(`  访问地址: http://127.0.0.1:${port}`);
  console.log('=============================================');

  const children = [];
  let shuttingDown = false;

  const stopChildren = (signal = 'SIGTERM') => {
    for (const ch of children) {
      if (ch.exitCode === null && !ch.killed) {
        try {
          ch.kill(signal);
        } catch {
          // ignore
        }
      }
    }
  };

  const handleSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在停止生产服务...');
    stopChildren(sig);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  if (hasSidecar) {
    const ocrPort = process.env['OCR_PORT'] || '8788';
    console.log(`  OCR Sidecar: http://127.0.0.1:${ocrPort}`);
    const sidecar = spawn(sidecarPython, ['ocr_server.py'], {
      cwd: sidecarDir,
      env: childEnv,
      stdio: 'inherit',
    });
    children.push(sidecar);
  }

  const server = spawn('pnpm', ['--filter', '@wenjv/server', 'start'], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
    shell: IS_WIN,
  });
  children.push(server);

  server.on('error', (err) => {
    console.error(`启动服务失败: ${err.message}`);
    shuttingDown = true;
    stopChildren();
    process.exit(1);
  });

  server.on('exit', (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      stopChildren();
    }
    if (signal && code === null) {
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
