#!/usr/bin/env node
/**
 * 维护者脚本：跨平台将本地检索 ONNX 模型与 OCR 模型（RapidOCR PP-OCRv5 Mobile + Pix2Text）
 * 打包为 GitHub Releases 可分发归档并生成 SHA256SUMS 与发布说明。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(ROOT, '..');

const RAPIDOCR_FILES = [
  'ch_PP-OCRv5_det_mobile.onnx',
  'ch_PP-OCRv5_rec_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
];

const PIX2TEXT_COMPONENTS = [
  {
    name: 'pix2text',
    envKey: 'PIX2TEXT_HOME',
    dotName: '.pix2text',
    checkRel: path.join('1.1', 'mfr-1.5-onnx', 'encoder_model.onnx'),
  },
  {
    name: 'cnocr',
    envKey: 'CNOCR_HOME',
    dotName: '.cnocr',
    checkRel: path.join('2.3', 'densenet_lite_136-gru', 'cnocr-v2.3-densenet_lite_136-gru-epoch=004-ft-model.onnx'),
  },
  {
    name: 'cnstd',
    envKey: 'CNSTD_HOME',
    dotName: '.cnstd',
    checkRel: path.join('1.2', 'ppocr', 'multi_PP-OCRv6_det_small', 'PP-OCRv6_det_small.onnx'),
  },
];

function printUsage() {
  console.log(`用法: node scripts/package-models.mjs [选项]

将本地 ONNX 模型（检索模型 + OCR 模型）打包为 .tar.gz 归档并生成 SHA256SUMS 与 RELEASE_NOTES.md。

选项:
  --models-dir <路径>   本地模型根目录（默认: ../models）
  --out-dir <路径>      归档输出目录（默认: ../dist-models）
  --tag <标签>          Release 标签名（默认: v1.0.0）
  --repo <owner/repo>   GitHub 仓库（默认: danzeyanan/wenjv）
  --skip-ocr            跳过 OCR 模型（仅打包 bge_m3_onnx / bge_reranker_base / siglip2_onnx）
  -h, --help            显示帮助信息`);
}

function parseArgs(argv) {
  const opts = {
    modelsDir: process.env['MODELS_DIR'] || path.resolve(REPO_ROOT, 'models'),
    outDir: process.env['OUT_DIR'] || path.resolve(REPO_ROOT, 'dist-models'),
    tag: process.env['WENJV_MODELS_TAG'] || 'v1.0.0',
    repo: process.env['WENJV_GITHUB_REPO'] || 'danzeyanan/wenjv',
    skipOcr: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--skip-ocr') {
      opts.skipOcr = true;
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
      case '--models-dir':
        opts.modelsDir = nextVal();
        break;
      case '--out-dir':
        opts.outDir = nextVal();
        break;
      case '--tag':
        opts.tag = nextVal();
        break;
      case '--repo':
        opts.repo = nextVal();
        break;
      default:
        console.error(`未知参数: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  opts.modelsDir = path.resolve(opts.modelsDir);
  opts.outDir = path.resolve(opts.outDir);
  return opts;
}

function copyDirFiltered(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (
      entry.name === '.cache' ||
      entry.name === '.gitattributes' ||
      entry.name === '.DS_Store' ||
      entry.name === '__pycache__'
    ) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    } else if (entry.isSymbolicLink()) {
      const stat = fs.statSync(srcPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        copyDirFiltered(srcPath, dstPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function resolveRapidOcrSourceDir(modelsDir) {
  const candidates = [path.join(modelsDir, 'ocr_rapidocr')];
  const winSiteModels = path.join(ROOT, 'sidecar', '.venv', 'Lib', 'site-packages', 'rapidocr', 'models');
  candidates.push(winSiteModels);

  const posixLibDir = path.join(ROOT, 'sidecar', '.venv', 'lib');
  if (fs.existsSync(posixLibDir)) {
    for (const entry of fs.readdirSync(posixLibDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('python')) {
        candidates.push(path.join(posixLibDir, entry.name, 'site-packages', 'rapidocr', 'models'));
      }
    }
  }

  for (const dir of candidates) {
    if (RAPIDOCR_FILES.every((f) => fs.existsSync(path.join(dir, f)))) {
      return dir;
    }
  }
  return null;
}

function resolvePix2TextComponentDirs(modelsDir) {
  const home = os.homedir();
  const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
  const resolved = {};

  for (const comp of PIX2TEXT_COMPONENTS) {
    const candidates = [path.join(modelsDir, 'ocr_pix2text', comp.name)];
    const envVal = process.env[comp.envKey];
    if (envVal) candidates.push(envVal);
    candidates.push(path.join(home, comp.dotName));
    if (process.platform === 'win32') {
      candidates.push(path.join(appData, comp.name));
    }

    const found = candidates.find((dir) => fs.existsSync(path.join(dir, comp.checkRel)));
    if (!found) {
      throw new Error(
        `未找到 OCR 组件 ${comp.name}（缺少 ${comp.checkRel}），请先在 sidecar 中运行一次 OCR 或安装至 models/ocr_pix2text/${comp.name}`
      );
    }
    resolved[comp.name] = found;
  }

  return resolved;
}

async function createTarGz(baseDir, dirName, outFile, extraExcludes = []) {
  const args = [
    '--exclude=*/.cache',
    '--exclude=*/.DS_Store',
    ...extraExcludes,
    '-czf',
    '-',
    dirName,
  ];
  const tmpFile = `${outFile}.tmp`;
  fs.rmSync(tmpFile, { force: true });

  await new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      cwd: baseDir,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const ws = fs.createWriteStream(tmpFile);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      fs.rmSync(tmpFile, { force: true });
      reject(err);
    };

    child.on('error', fail);
    ws.on('error', fail);
    child.stdout.pipe(ws);

    let childCode = null;
    let wsFinished = false;

    const maybeDone = () => {
      if (settled || childCode === null || !wsFinished) return;
      if (childCode !== 0) {
        fail(new Error(`tar 打包 ${dirName} 失败（退出码 ${childCode}）`));
      } else {
        settled = true;
        resolve();
      }
    };

    child.on('close', (code) => {
      childCode = code ?? 1;
      maybeDone();
    });
    ws.on('finish', () => {
      wsFinished = true;
      maybeDone();
    });
  });

  fs.renameSync(tmpFile, outFile);
}

async function calcSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(filePath);
  for await (const chunk of rs) {
    hash.update(chunk);
  }
  return hash.digest('hex').toLowerCase();
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))}M`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const tarCheck = spawnSync('tar', ['--version'], { stdio: 'ignore' });
  if (tarCheck.error) {
    console.error(`错误：未找到可用 tar 命令：${tarCheck.error.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(opts.modelsDir)) {
    console.error(`错误：模型目录不存在：${opts.modelsDir}`);
    process.exit(1);
  }

  const requiredFiles = [
    ['bge_m3_onnx', 'model_quantized.onnx'],
    ['bge_m3_onnx', 'tokenizer.json'],
    ['bge_reranker_base', 'model_quantized.onnx'],
    ['bge_reranker_base', 'tokenizer.json'],
    ['siglip2_onnx', 'onnx', 'text_model_int8.onnx'],
    ['siglip2_onnx', 'tokenizer.json'],
    ['siglip2_onnx', 'onnx', 'vision_model_q4.onnx'],
  ];

  for (const parts of requiredFiles) {
    const p = path.join(opts.modelsDir, ...parts);
    if (!fs.existsSync(p)) {
      console.error(`错误：缺少必需模型文件：${p}`);
      process.exit(1);
    }
  }

  let rapidOcrSource = null;
  let pix2TextSources = null;
  if (!opts.skipOcr) {
    rapidOcrSource = resolveRapidOcrSourceDir(opts.modelsDir);
    if (!rapidOcrSource) {
      console.error('错误：未找到 RapidOCR (PP-OCRv5 Mobile) 模型文件（models/ocr_rapidocr 或 sidecar/.venv）。');
      process.exit(1);
    }
    pix2TextSources = resolvePix2TextComponentDirs(opts.modelsDir);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const totalSteps = opts.skipOcr ? 4 : 6;

  console.log('=============================================');
  console.log('  wenjv 本地模型打包');
  console.log(`  源目录:   ${opts.modelsDir}`);
  if (!opts.skipOcr) {
    console.log(`  RapidOCR: ${rapidOcrSource}`);
    console.log(`  Pix2Text: ${pix2TextSources.pix2text}`);
  }
  console.log(`  输出目录: ${opts.outDir}`);
  console.log(`  目标 Tag: ${opts.tag}`);
  console.log('=============================================');

  console.log(`[1/${totalSteps}] 打包 bge_m3_onnx.tar.gz ...`);
  await createTarGz(opts.modelsDir, 'bge_m3_onnx', path.join(opts.outDir, 'bge_m3_onnx.tar.gz'));

  console.log(`[2/${totalSteps}] 打包 bge_reranker_base.tar.gz ...`);
  await createTarGz(
    opts.modelsDir,
    'bge_reranker_base',
    path.join(opts.outDir, 'bge_reranker_base.tar.gz')
  );

  console.log(`[3/${totalSteps}] 打包 siglip2_onnx.tar.gz ...`);
  const siglipExcludes = [];
  if (fs.existsSync(path.join(opts.modelsDir, 'siglip2_onnx', 'onnx', 'vision_model_q4.onnx'))) {
    // CPU 推理默认优先加载 vision_model_q4.onnx，打包时排除未使用的 int8 视觉模型以节省约 91 MB
    siglipExcludes.push('--exclude=siglip2_onnx/onnx/vision_model_int8.onnx');
  }
  await createTarGz(
    opts.modelsDir,
    'siglip2_onnx',
    path.join(opts.outDir, 'siglip2_onnx.tar.gz'),
    siglipExcludes
  );

  const archives = ['bge_m3_onnx.tar.gz', 'bge_reranker_base.tar.gz', 'siglip2_onnx.tar.gz'];

  if (!opts.skipOcr) {
    console.log(`[4/${totalSteps}] 打包 ocr_rapidocr.tar.gz ...`);
    const stageRapid = path.join(opts.outDir, '.stage-rapidocr');
    fs.rmSync(stageRapid, { recursive: true, force: true });
    try {
      const target = path.join(stageRapid, 'ocr_rapidocr');
      fs.mkdirSync(target, { recursive: true });
      for (const f of RAPIDOCR_FILES) {
        fs.copyFileSync(path.join(rapidOcrSource, f), path.join(target, f));
      }
      await createTarGz(stageRapid, 'ocr_rapidocr', path.join(opts.outDir, 'ocr_rapidocr.tar.gz'));
      archives.push('ocr_rapidocr.tar.gz');
    } finally {
      fs.rmSync(stageRapid, { recursive: true, force: true });
    }

    console.log(`[5/${totalSteps}] 打包 ocr_pix2text.tar.gz ...`);
    const stageP2t = path.join(opts.outDir, '.stage-pix2text');
    fs.rmSync(stageP2t, { recursive: true, force: true });
    try {
      const targetRoot = path.join(stageP2t, 'ocr_pix2text');
      for (const comp of PIX2TEXT_COMPONENTS) {
        copyDirFiltered(pix2TextSources[comp.name], path.join(targetRoot, comp.name));
      }
      await createTarGz(stageP2t, 'ocr_pix2text', path.join(opts.outDir, 'ocr_pix2text.tar.gz'));
      archives.push('ocr_pix2text.tar.gz');
    } finally {
      fs.rmSync(stageP2t, { recursive: true, force: true });
    }
  }

  console.log(`[${totalSteps}/${totalSteps}] 校验归档并生成 SHA256SUMS ...`);
  const shaLines = [];
  const sizes = {};
  for (const arch of archives) {
    const verify = spawnSync('tar', ['-tzf', arch], {
      cwd: opts.outDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (verify.error || verify.status !== 0) {
      throw new Error(`校验归档 ${arch} 失败`);
    }
    const fullPath = path.join(opts.outDir, arch);
    sizes[arch] = formatSize(fs.statSync(fullPath).size);
    const hash = await calcSha256(fullPath);
    shaLines.push(`${hash}  ${arch}`);
  }

  const shaContents = shaLines.join('\n');
  fs.writeFileSync(path.join(opts.outDir, 'SHA256SUMS'), `${shaContents}\n`, 'utf8');

  const modelRows = [
    `| \`bge_m3_onnx.tar.gz\` | ${sizes['bge_m3_onnx.tar.gz']} | 文本向量嵌入（1024 维量化 ONNX） | [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)（MIT） |`,
    `| \`bge_reranker_base.tar.gz\` | ${sizes['bge_reranker_base.tar.gz']} | 二阶段检索语义精排（量化 ONNX） | [BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base)（MIT） |`,
    `| \`siglip2_onnx.tar.gz\` | ${sizes['siglip2_onnx.tar.gz']} | 跨模态图文向量与以图搜图（含 \`vision_model_q4.onnx\`） | [google/siglip2](https://huggingface.co/google/siglip2)（Apache-2.0） |`,
  ];
  if (!opts.skipOcr) {
    modelRows.push(
      `| \`ocr_rapidocr.tar.gz\` | ${sizes['ocr_rapidocr.tar.gz']} | 通用中英文 OCR（PP-OCRv5 Mobile ONNX） | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR)（Apache-2.0） |`,
      `| \`ocr_pix2text.tar.gz\` | ${sizes['ocr_pix2text.tar.gz']} | 理工科数学公式与版面识别（Pix2Text + CnOCR + CnSTD） | [breezedeus/Pix2Text](https://github.com/breezedeus/Pix2Text)（MIT）/ CnOCR・CnSTD（Apache-2.0） |`
    );
  }

  const releaseNotes = `## 问据（wenjv）本地推理模型包（${opts.tag}）

用于 \`wenjv-ts\` 开箱即用的本地 CPU 检索与 OCR 识图权重（与代码仓内跨平台 \`pnpm run download-models\` 脚本配套）。

### 模型清单与开源协议

| 归档文件 | 压缩体积 | 用途 | 上游模型与协议 |
| :--- | :---: | :--- | :--- |
${modelRows.join('\n')}

### 一键下载与校验安装

在 \`wenjv-ts/\` 目录下运行（Windows PowerShell / CMD / macOS / Linux 通用）：

\`\`\`bash
# 默认从 GitHub Releases (${opts.tag}) 下载全部模型并自动校验 SHA256
pnpm run download-models

# 仅下载 OCR 模型 / 跳过 OCR 模型
pnpm run download-models -- --only ocr
pnpm run download-models -- --no-ocr

# Linux / macOS 国内网络代理加速
WENJV_GITHUB_PROXY=https://gh-proxy.com/ pnpm run download-models

# Windows PowerShell 国内网络代理加速
$env:WENJV_GITHUB_PROXY="https://gh-proxy.com/"; pnpm run download-models

# 指定自定义镜像地址（如 ModelScope / Hugging Face / 内网文件服务器）
pnpm run download-models -- --base-url https://your-mirror.example.com/wenjv-models
\`\`\`

### SHA256 校验值（\`SHA256SUMS\`）

\`\`\`text
${shaContents}
\`\`\`
`;

  fs.writeFileSync(path.join(opts.outDir, 'RELEASE_NOTES.md'), releaseNotes, 'utf8');

  console.log('');
  console.log('打包完成！生成文件列表：');
  for (const name of [...archives, 'SHA256SUMS', 'RELEASE_NOTES.md']) {
    const st = fs.statSync(path.join(opts.outDir, name));
    console.log(`  - ${name.padEnd(28)} ${st.size} bytes`);
  }
  console.log('');
  console.log('下一步：上传至 GitHub Releases');
  console.log('  方式 A（网页端手动发布）：');
  console.log(`    1. 打开 https://github.com/${opts.repo}/releases/new?tag=${opts.tag}`);
  console.log(`    2. Release title 填写: Local ONNX & OCR Models (${opts.tag})`);
  console.log(`    3. 正文可粘贴: ${path.join(opts.outDir, 'RELEASE_NOTES.md')}`);
  console.log(`    4. 上传以下 ${archives.length + 1} 个附件:`);
  for (const name of [...archives, 'SHA256SUMS']) {
    console.log(`       - ${path.join(opts.outDir, name)}`);
  }
  console.log('');
  console.log('  方式 B（GitHub CLI 一键发布）：');
  console.log(`    gh release create ${opts.tag} \\`);
  for (const name of [...archives, 'SHA256SUMS']) {
    console.log(`      "${path.join(opts.outDir, name)}" \\`);
  }
  console.log(`      --title "Local ONNX & OCR Models (${opts.tag})" \\`);
  console.log(`      --notes-file "${path.join(opts.outDir, 'RELEASE_NOTES.md')}"`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
