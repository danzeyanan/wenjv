#!/usr/bin/env bash
# 环境体检。任何一项失败，退出码非 0。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"

fail=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

echo "== 工具链"
node_path="$(command -v node || true)"
if [[ "$node_path" == "$WENJV_NODE_HOME/bin/node" ]]; then ok "node 路径 $node_path"; else bad "node 路径异常: '${node_path}'（期望 $WENJV_NODE_HOME/bin/node）"; fi

want_node="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
have_node="$(node -v 2>/dev/null | sed 's/^v//')"
if [[ "$have_node" == "$want_node" ]]; then ok "node 版本 $have_node"; else bad "node 版本 $have_node ≠ .nvmrc $want_node"; fi

pnpm_path="$(command -v pnpm || true)"
case "$pnpm_path" in
  /mnt/*|"") bad "pnpm 不可用或来自 Windows: '${pnpm_path}'" ;;
  *) ok "pnpm 路径 $pnpm_path" ;;
esac
want_pnpm="$(node -p "require('$ROOT/package.json').packageManager.split('@')[1]")"
have_pnpm="$(cd "$ROOT" && pnpm -v 2>/dev/null)"
if [[ "$have_pnpm" == "$want_pnpm" ]]; then ok "pnpm 版本 $have_pnpm"; else bad "pnpm 版本 '$have_pnpm' ≠ packageManager $want_pnpm"; fi

if echo "$PATH" | tr ':' '\n' | grep -q '^/mnt/'; then bad "PATH 仍含 Windows 路径"; else ok "PATH 无 Windows 条目"; fi

echo "== 网络"
code="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' https://registry.npmmirror.com/hono 2>/dev/null || true)"
if [[ "$code" == "200" ]]; then ok "registry.npmmirror.com 可达"; else bad "registry.npmmirror.com 不可达 (http=$code)"; fi

echo "== 原生模块（需先 pnpm install）"
if [[ -d "$ROOT/node_modules" ]]; then
  (cd "$ROOT/packages/server" && node --input-type=module -e "
    const checks = [
      ['better-sqlite3', async () => { const D = (await import('better-sqlite3')).default; const db = new D(':memory:'); db.exec(\"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')\"); return 'sqlite ' + db.prepare('select sqlite_version() v').get().v; }],
      ['sharp', async () => { const s = (await import('sharp')).default; return 'libvips ' + s.versions.vips; }],
      ['onnxruntime-node', async () => { const o = await import('onnxruntime-node'); return 'backends ok ' + typeof o.InferenceSession.create; }],
      ['@lancedb/lancedb', async () => { const l = await import('@lancedb/lancedb'); return 'connect ' + typeof l.connect; }],
      ['@node-rs/argon2', async () => { const a = await import('@node-rs/argon2'); return 'hash ' + typeof a.hash; }],
    ];
    let bad = 0;
    for (const [name, fn] of checks) {
      try { console.log('  \x1b[32mOK\x1b[0m   ' + name + ' → ' + await fn()); }
      catch (e) { bad = 1; console.log('  \x1b[31mFAIL\x1b[0m ' + name + ' → ' + (e instanceof Error ? e.message : String(e))); }
    }
    process.exit(bad);
  ") || fail=1
else
  bad "node_modules 不存在，先运行 pnpm install"
fi

echo "== 本地 ONNX 模型"
MODELS_DIR="${MODELS_DIR:-$(cd "$ROOT/.." && pwd)/models}"
models_missing=0
if [[ -f "$MODELS_DIR/bge_m3_onnx/model_quantized.onnx" && -f "$MODELS_DIR/bge_m3_onnx/tokenizer.json" ]]; then
  ok "bge_m3_onnx → $MODELS_DIR/bge_m3_onnx"
else
  warn "bge_m3_onnx 缺失（$MODELS_DIR/bge_m3_onnx）"
  models_missing=1
fi
if [[ -f "$MODELS_DIR/bge_reranker_base/model_quantized.onnx" && -f "$MODELS_DIR/bge_reranker_base/tokenizer.json" ]]; then
  ok "bge_reranker_base → $MODELS_DIR/bge_reranker_base"
else
  warn "bge_reranker_base 缺失（$MODELS_DIR/bge_reranker_base）"
  models_missing=1
fi
siglip_vision_ok=0
for cand in vision_model_q4.onnx vision_model_q4f16.onnx vision_model.onnx vision_model_fp16.onnx vision_model_int8.onnx; do
  if [[ -f "$MODELS_DIR/siglip2_onnx/onnx/$cand" ]]; then
    siglip_vision_ok=1
    break
  fi
done
if [[ -f "$MODELS_DIR/siglip2_onnx/onnx/text_model_int8.onnx" && -f "$MODELS_DIR/siglip2_onnx/tokenizer.json" && $siglip_vision_ok -eq 1 ]]; then
  ok "siglip2_onnx → $MODELS_DIR/siglip2_onnx"
else
  warn "siglip2_onnx 缺失（$MODELS_DIR/siglip2_onnx）"
  models_missing=1
fi
if [[ -f "$MODELS_DIR/ocr_rapidocr/ch_PP-OCRv5_det_mobile.onnx" \
   && -f "$MODELS_DIR/ocr_rapidocr/ch_PP-OCRv5_rec_mobile.onnx" \
   && -f "$MODELS_DIR/ocr_rapidocr/ch_ppocr_mobile_v2.0_cls_mobile.onnx" ]]; then
  ok "ocr_rapidocr → $MODELS_DIR/ocr_rapidocr"
else
  warn "ocr_rapidocr 缺失（$MODELS_DIR/ocr_rapidocr）"
  models_missing=1
fi
if [[ -f "$MODELS_DIR/ocr_pix2text/pix2text/1.1/mfd-1.5-onnx/pix2text-mfd-1.5.onnx" \
   && -f "$MODELS_DIR/ocr_pix2text/pix2text/1.1/mfr-1.5-onnx/encoder_model.onnx" \
   && -f "$MODELS_DIR/ocr_pix2text/pix2text/1.1/mfr-1.5-onnx/decoder_model.onnx" \
   && -f "$MODELS_DIR/ocr_pix2text/cnocr/2.3/densenet_lite_136-gru/cnocr-v2.3-densenet_lite_136-gru-epoch=004-ft-model.onnx" \
   && -f "$MODELS_DIR/ocr_pix2text/cnstd/1.2/ppocr/multi_PP-OCRv6_det_small/PP-OCRv6_det_small.onnx" ]]; then
  ok "ocr_pix2text → $MODELS_DIR/ocr_pix2text"
else
  warn "ocr_pix2text 缺失（$MODELS_DIR/ocr_pix2text）"
  models_missing=1
fi
if [[ $models_missing -eq 1 ]]; then
  echo "  提示：可运行 pnpm run download-models 一键下载本地模型（不启用本地检索或 OCR 可忽略）。"
fi

echo
if [[ $fail -eq 0 ]]; then echo "doctor: 全部通过"; else echo "doctor: 存在失败项"; fi
exit $fail
