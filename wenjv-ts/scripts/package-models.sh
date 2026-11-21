#!/usr/bin/env bash
# 兼容入口：委托给跨平台 Node.js 脚本 scripts/package-models.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/scripts/env.sh" ]] && { ! command -v node >/dev/null 2>&1 || [[ -x "${WENJV_NODE_HOME:-$HOME/.local/node-v22.23.4-linux-x64}/bin/node" ]]; }; then
  # shellcheck source=env.sh
  source "$ROOT/scripts/env.sh"
fi
exec node "$ROOT/scripts/package-models.mjs" "$@"
