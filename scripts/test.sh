#!/usr/bin/env bash
# e2e self-test, robust to node-installed-via-nvm in non-interactive shells.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .node-bin-dir ]; then
  export PATH="$(cat .node-bin-dir):$PATH"
fi
exec npm test "$@"
