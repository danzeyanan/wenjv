#!/usr/bin/env node
/**
 * 跨平台一键下载并校验问据（wenjv）本地 ONNX 模型（Windows / macOS / Linux 通用）。
 * 涵盖检索模型（BGE-M3 / BGE-Reranker / SigLIP2）与 OCR 模型（RapidOCR PP-OCRv5 / Pix2Text）。
 * 支持断点续传（HTTP Range）、SHA256 校验、原子解压替换、GitHub 代理与自定义镜像。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(ROOT, '..');

export const RETRIEVAL_MODELS = ['bge_m3_onnx', 'bge_reranker_base', 'siglip2_onnx'];
export const OCR_MODELS = ['ocr_rapidocr', 'ocr_pix2text'];
export const VALID_MODELS = [...RETRIEVAL_MODELS, ...OCR_MODELS];

const SIGLIP_VISION_CANDIDATES = [
  'vision_model_q4.onnx',
  'vision_model_q4f16.onnx',
  'vision_model.onnx',
  'vision_model_fp16.onnx',
  'vision_model_int8.onnx',
];

const RAPIDOCR_REQUIRED_FILES = [
  'ch_PP-OCRv5_det_mobile.onnx',
  'ch_PP-OCRv5_rec_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
];

const PIX2TEXT_REQUIRED_FILES = [
  ['pix2text', '1.1', 'mfd-1.5-onnx', 'pix2text-mfd-1.5.onnx'],
  ['pix2text', '1.1', 'mfr-1.5-onnx', 'encoder_model.onnx'],
  ['pix2text', '1.1', 'mfr-1.5-onnx', 'decoder_model.onnx'],
  ['cnocr', '2.3', 'densenet_lite_136-gru', 'cnocr-v2.3-densenet_lite_136-gru-epoch=004-ft-model.onnx'],
  ['cnstd', '1.2', 'ppocr', 'multi_PP-OCRv6_det_small', 'PP-OCRv6_det_small.onnx'],
];

const C_GREEN = process.stdout.isTTY ? '\x1b[32m' : '';
const C_YELLOW = process.stdout.isTTY ? '\x1b[33m' : '';
const C_RED = process.stderr.isTTY ? '\x1b[31m' : '';
const C_RESET = process.stdout.isTTY || process.stderr.isTTY ? '\x1b[0m' : '';

const logOk = (msg) => console.log(`  ${C_GREEN}OK${C_RESET}   ${msg}`);
const logWarn = (msg) => console.log(`  ${C_YELLOW}WARN${C_RESET} ${msg}`);
const logErr = (msg) => console.error(`  ${C_RED}FAIL${C_RESET} ${msg}`);

function printUsage() {
  console.log(`用法: node scripts/download-models.mjs [选项]

一键下载并校验本地模型包（含检索 ONNX + 本地 CPU OCR 模型）。
原生支持 Windows (PowerShell / CMD)、macOS 与 Linux。

模型分组:
  retrieval  检索模型：bge_m3_onnx, bge_reranker_base, siglip2_onnx
  ocr        OCR 模型：ocr_rapidocr (PP-OCRv5 Mobile), ocr_pix2text (Pix2Text 公式/版面)

选项:
  --dir <路径>          目标模型目录（默认: $MODELS_DIR 或 ../models）
  --tag <标签>          GitHub Release 标签（默认: v1.0.0）
  --repo <owner/repo>   GitHub 仓库（默认: danzeyanan/wenjv）
  --base-url <URL>      自定义模型包基地址（如 ModelScope / Hugging Face / 内网目录）
  --proxy <前缀>        GitHub 下载代理前缀（如 https://gh-proxy.com/）
  --only <名称>         仅下载指定模型或分组（可多次传入或逗号分隔）：
                        retrieval, ocr, ${VALID_MODELS.join(', ')}
  --no-ocr              跳过 OCR 模型，仅下载检索模型（等同 --only retrieval）
  --force               强制重新下载并替换已有模型
  --skip-verify         跳过 SHA256 校验
  -h, --help            显示帮助信息

示例:
  # 默认下载全部 5 个模型包（检索 + OCR）
  pnpm run download-models

  # 仅下载 OCR 模型或仅下载检索模型:
  pnpm run download-models -- --only ocr
  pnpm run download-models -- --no-ocr

  # Linux / macOS 代理加速:
  WENJV_GITHUB_PROXY=https://gh-proxy.com/ pnpm run download-models

  # Windows PowerShell 代理加速:
  $env:WENJV_GITHUB_PROXY="https://gh-proxy.com/"; pnpm run download-models`);
}

function addSelectedModels(selected, raw) {
  for (const part of String(raw).split(',')) {
    const item = part.trim();
    if (!item) continue;
    let expanded;
    if (item === 'retrieval') {
      expanded = RETRIEVAL_MODELS;
    } else if (item === 'ocr') {
      expanded = OCR_MODELS;
    } else if (VALID_MODELS.includes(item)) {
      expanded = [item];
    } else {
      console.error(`错误：不支持的模型名称 '${item}'（可选: retrieval, ocr, ${VALID_MODELS.join(', ')}）`);
      process.exit(1);
    }
    for (const m of expanded) {
      if (!selected.includes(m)) {
        selected.push(m);
      }
    }
  }
}

function parseArgs(argv) {
  const opts = {
    modelsDir: process.env['MODELS_DIR'] || path.resolve(REPO_ROOT, 'models'),
    repo: process.env['WENJV_GITHUB_REPO'] || 'danzeyanan/wenjv',
    tag: process.env['WENJV_MODELS_TAG'] || 'v1.0.0',
    proxy: process.env['WENJV_GITHUB_PROXY'] || '',
    baseUrl: process.env['WENJV_MODELS_BASE_URL'] || '',
    noOcr: false,
    force: false,
    skipVerify: false,
    selected: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--force') {
      opts.force = true;
      continue;
    }
    if (arg === '--skip-verify') {
      opts.skipVerify = true;
      continue;
    }
    if (arg === '--no-ocr') {
      opts.noOcr = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const nextVal = () => {
      if (eqIdx !== -1) return arg.slice(eqIdx + 1);
      if (i + 1 >= argv.length) {
        console.error(`错误：参数 ${flag} 缺少值`);
        process.exit(1);
      }
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '--dir':
        opts.modelsDir = nextVal();
        break;
      case '--tag':
        opts.tag = nextVal();
        break;
      case '--repo':
        opts.repo = nextVal();
        break;
      case '--base-url':
        opts.baseUrl = nextVal();
        break;
      case '--proxy':
        opts.proxy = nextVal();
        break;
      case '--only':
        addSelectedModels(opts.selected, nextVal());
        break;
      default:
        console.error(`未知参数: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  if (opts.selected.length === 0) {
    opts.selected = opts.noOcr ? [...RETRIEVAL_MODELS] : [...VALID_MODELS];
  } else if (opts.noOcr) {
    opts.selected = opts.selected.filter((m) => !OCR_MODELS.includes(m));
  }
  if (opts.selected.length === 0) {
    console.error('错误：过滤后没有待下载的模型。');
    process.exit(1);
  }
  opts.modelsDir = path.resolve(opts.modelsDir);
  return opts;
}

export function isModelReady(baseDir, name) {
  if (name === 'bge_m3_onnx' || name === 'bge_reranker_base') {
    return (
      fs.existsSync(path.join(baseDir, name, 'model_quantized.onnx')) &&
      fs.existsSync(path.join(baseDir, name, 'tokenizer.json'))
    );
  }
  if (name === 'siglip2_onnx') {
    const hasText = fs.existsSync(path.join(baseDir, name, 'onnx', 'text_model_int8.onnx'));
    const hasTok = fs.existsSync(path.join(baseDir, name, 'tokenizer.json'));
    const hasVision = SIGLIP_VISION_CANDIDATES.some((cand) =>
      fs.existsSync(path.join(baseDir, name, 'onnx', cand))
    );
    return hasText && hasTok && hasVision;
  }
  if (name === 'ocr_rapidocr') {
    return RAPIDOCR_REQUIRED_FILES.every((f) => fs.existsSync(path.join(baseDir, name, f)));
  }
  if (name === 'ocr_pix2text') {
    return PIX2TEXT_REQUIRED_FILES.every((parts) => fs.existsSync(path.join(baseDir, name, ...parts)));
  }
  return false;
}

function buildAssetUrl(opts, filename) {
  if (opts.baseUrl) {
    return `${opts.baseUrl.replace(/\/+$/, '')}/${filename}`;
  }
  const rawUrl = `https://github.com/${opts.repo}/releases/download/${opts.tag}/${filename}`;
  if (opts.proxy) {
    return `${opts.proxy.replace(/\/+$/, '')}/${rawUrl}`;
  }
  return rawUrl;
}

function printTroubleshoot() {
  console.error('');
  console.error('下载失败排查建议：');
  console.error('  1. 国内直连 GitHub Releases 较慢或超时时，可配置代理前缀：');
  console.error('     Bash:       WENJV_GITHUB_PROXY=https://gh-proxy.com/ pnpm run download-models');
  console.error('     PowerShell: $env:WENJV_GITHUB_PROXY="https://gh-proxy.com/"; pnpm run download-models');
  console.error('  2. 或指定自定义镜像基地址（如 ModelScope / Hugging Face / 内网 HTTP 目录）：');
  console.error('     pnpm run download-models -- --base-url https://your-mirror.example.com/wenjv-models');
  console.error('  3. 若暂不部署本地模型，可加 --no-ocr 跳过 OCR，或在 backend.env 中改用云端 Embedding / Rerank：');
  console.error('     EMBEDDING_PROVIDER=siliconflow / RERANK_PROVIDER=siliconflow');
}

async function fetchSha256Map(shaUrl) {
  const map = new Map();
  try {
    const res = await fetch(shaUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^([0-9a-fA-F]{64})\s+\*?\.?\/?(.+)$/);
      if (m) {
        map.set(m[2].trim(), m[1].toLowerCase());
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function downloadWithResume(url, partFile) {
  const maxAttempts = 3;
  let rangeResetUsed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let existingSize = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
    const headers = {};
    if (existingSize > 0) {
      headers['Range'] = `bytes=${existingSize}-`;
    }

    try {
      const res = await fetch(url, { redirect: 'follow', headers });

      if (res.status === 416 && existingSize > 0 && !rangeResetUsed) {
        rangeResetUsed = true;
        logWarn(`检测到不匹配的断点缓存，正在清理并从头下载 ${path.basename(partFile)} ...`);
        fs.rmSync(partFile, { force: true });
        attempt -= 1;
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        throw new Error('响应体为空');
      }

      const isPartial = res.status === 206 && existingSize > 0;
      const writeFlags = isPartial ? 'a' : 'w';
      let downloaded = isPartial ? existingSize : 0;

      let totalBytes = 0;
      if (isPartial) {
        const cr = res.headers.get('content-range') || '';
        const crMatch = cr.match(/\/(\d+)$/);
        if (crMatch) {
          totalBytes = Number(crMatch[1]);
        } else {
          const cl = Number(res.headers.get('content-length') || 0);
          totalBytes = cl > 0 ? existingSize + cl : 0;
        }
      } else {
        totalBytes = Number(res.headers.get('content-length') || 0);
      }

      const ws = fs.createWriteStream(partFile, { flags: writeFlags });
      const reader = res.body.getReader();
      let lastReportAt = 0;
      let lastPctBucket = -1;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          if (!ws.write(value)) {
            await once(ws, 'drain');
          }
          downloaded += value.byteLength;

          const now = Date.now();
          if (process.stdout.isTTY) {
            if (now - lastReportAt >= 200) {
              lastReportAt = now;
              if (totalBytes > 0) {
                const pct = Math.min(100, (downloaded / totalBytes) * 100).toFixed(1);
                process.stdout.write(
                  `\r  下载进度: ${pct}% (${formatMb(downloaded)} / ${formatMb(totalBytes)} MB)`
                );
              } else {
                process.stdout.write(`\r  已下载: ${formatMb(downloaded)} MB`);
              }
            }
          } else if (totalBytes > 0) {
            const bucket = Math.floor((downloaded / totalBytes) * 5);
            if (bucket > lastPctBucket) {
              lastPctBucket = bucket;
              console.log(`  进度: ${bucket * 20}% (${formatMb(downloaded)} / ${formatMb(totalBytes)} MB)`);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.end(resolve);
      });

      if (process.stdout.isTTY) {
        const finalInfo =
          totalBytes > 0
            ? `100.0% (${formatMb(downloaded)} / ${formatMb(totalBytes)} MB)`
            : `${formatMb(downloaded)} MB`;
        process.stdout.write(`\r  下载进度: ${finalInfo}\n`);
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        logWarn(`下载受阻（第 ${attempt}/${maxAttempts} 次尝试）：${msg}，2 秒后重试...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw new Error(msg);
      }
    }
  }
}

async function calcSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(filePath);
  for await (const chunk of rs) {
    hash.update(chunk);
  }
  return hash.digest('hex').toLowerCase();
}

function checkTarAvailable() {
  const res = spawnSync('tar', ['--version'], { stdio: 'ignore' });
  if (res.error) {
    logErr(`未找到可用 tar 命令（${res.error.message}），无法解压模型归档。`);
    process.exit(1);
  }
}

function extractArchive(partFile, extractDir) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  // 使用相对正斜杠路径，规避 Windows Git Bash GNU tar 将盘符 C: 误识别为 SSH 主机名的问题
  const relPartPath = path.relative(extractDir, partFile).replaceAll('\\', '/');
  const res = spawnSync('tar', ['-xzf', relPartPath, '-C', '.'], {
    cwd: extractDir,
    stdio: 'inherit',
  });
  if (res.error || res.status !== 0) {
    throw new Error(res.error ? res.error.message : `tar 退出码 ${res.status}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const toFetch = [];
  for (const name of opts.selected) {
    if (!opts.force && isModelReady(opts.modelsDir, name)) {
      logOk(`${name} 已就绪，跳过下载（${path.join(opts.modelsDir, name)}）`);
    } else {
      toFetch.push(name);
    }
  }

  if (toFetch.length === 0) {
    console.log(`所有目标本地模型均已就绪：${opts.modelsDir}`);
    return;
  }

  checkTarAvailable();
  fs.mkdirSync(opts.modelsDir, { recursive: true });
  const cacheDir = path.join(opts.modelsDir, '.download-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  let shaMap = null;
  if (!opts.skipVerify) {
    const shaUrl = buildAssetUrl(opts, 'SHA256SUMS');
    console.log(`获取校验清单: ${shaUrl}`);
    shaMap = await fetchSha256Map(shaUrl);
    if (shaMap) {
      logOk('已获取 SHA256SUMS');
    } else {
      logWarn('未获取到 SHA256SUMS（可能是镜像未提供或网络异常），将跳过 SHA256 校验继续下载。');
    }
  }

  for (const name of toFetch) {
    const archive = `${name}.tar.gz`;
    const url = buildAssetUrl(opts, archive);
    const partFile = path.join(cacheDir, `${archive}.part`);
    const extractDir = path.join(cacheDir, `extract-${name}`);
    const backupDir = path.join(cacheDir, `backup-${name}`);
    const targetDir = path.join(opts.modelsDir, name);

    console.log('');
    console.log(`正在下载 ${archive} ...`);
    console.log(`  来源: ${url}`);

    try {
      await downloadWithResume(url, partFile);
    } catch (err) {
      logErr(`下载 ${archive} 失败（${err instanceof Error ? err.message : String(err)}）。`);
      printTroubleshoot();
      process.exit(1);
    }

    if (!opts.skipVerify && shaMap) {
      const expectedSha = shaMap.get(archive);
      if (!expectedSha) {
        fs.rmSync(partFile, { force: true });
        logErr(`SHA256SUMS 中缺少 ${archive} 的校验记录，已清理下载文件并中止。`);
        process.exit(1);
      }
      const actualSha = await calcSha256(partFile);
      if (actualSha !== expectedSha) {
        fs.rmSync(partFile, { force: true });
        logErr(`${archive} SHA256 校验失败！`);
        console.error(`  期望: ${expectedSha}`);
        console.error(`  实际: ${actualSha}`);
        process.exit(1);
      }
      logOk(`${archive} SHA256 校验通过`);
    }

    console.log(`正在解压并校验 ${name} ...`);
    try {
      extractArchive(partFile, extractDir);
    } catch (err) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      logErr(`解压 ${archive} 失败：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (!isModelReady(extractDir, name)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      logErr(`解压结果缺少预期模型文件（${name}），已中止替换。`);
      process.exit(1);
    }

    fs.rmSync(backupDir, { recursive: true, force: true });
    const extractedModelDir = path.join(extractDir, name);
    try {
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, backupDir);
      }
      fs.renameSync(extractedModelDir, targetDir);
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.rmSync(partFile, { force: true });
    } catch (err) {
      if (!fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
        try {
          fs.renameSync(backupDir, targetDir);
        } catch {
          // ignore restore failure
        }
      }
      fs.rmSync(extractDir, { recursive: true, force: true });
      logErr(`原子替换目标目录失败（${targetDir}）：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    logOk(`${name} 安装完成 → ${targetDir}`);
  }

  try {
    if (fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length === 0) {
      fs.rmdirSync(cacheDir);
    }
  } catch {
    // ignore cleanup if cache still holds partial files from previous runs
  }

  console.log('');
  console.log(`全部请求的本地模型已就绪：${opts.modelsDir}`);
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    logErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
