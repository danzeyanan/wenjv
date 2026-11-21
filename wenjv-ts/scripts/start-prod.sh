#!/usr/bin/env bash
# 兼容入口（Linux / WSL）：清理 PATH 后委托给跨平台 Node.js 脚本 scripts/start-prod.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/scripts/env.sh" ]]; then
  # shellcheck source=env.sh
  source "$ROOT/scripts/env.sh"
fi
exec node "$ROOT/scripts/start-prod.mjs" "$@"
