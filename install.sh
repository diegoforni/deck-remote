#!/usr/bin/env bash
# deck-remote installer — macOS and Linux, no sudo required.
# Installs Node.js LTS (via nvm, only if missing or older than 18), the
# project's dependencies, and the OCR language model cache. Idempotent:
# re-run any time. Safe after scp'ing the folder from another OS/arch
# (native modules are always reinstalled cleanly).
set -euo pipefail

cd "$(dirname "$0")"
say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. Node.js >= 18 ----------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -e 'console.log(parseInt(process.versions.node.split(".")[0],10) || 0)')"
  [ "$major" -ge 18 ]
}

if node_ok; then
  say "Node.js $(node -v) found"
else
  say "Node.js >= 18 not found — installing the LTS via nvm (no sudo)…"
  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required to install nvm; install curl first"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
      || die "nvm installer failed (need internet)"
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" || die "could not load nvm"
  nvm install --lts || die "nvm could not install Node.js"
  node_ok || die "Node >= 18 still unavailable — install it from https://nodejs.org and re-run"
  say "Node.js $(node -v) installed via nvm"
fi

# ---- 2. dependencies ------------------------------------------------------
say "Installing dependencies (npm install)…"
rm -rf node_modules
npm install --no-audit --no-fund || die "npm install failed (need internet)"

# ---- 3. sanity check ------------------------------------------------------
node -e "['ws','sharp','qrcode','qrcode-terminal','tesseract.js'].forEach(require); console.log('modules load ok')" \
  || die "module check failed — try: rm -rf node_modules && npm install"

# ---- 4. OCR model cache (offline-ready first run) -------------------------
say "Preparing OCR language model…"
node scripts/warm-ocr.js || die "OCR model setup failed (internet needed once)"

say "Install complete."
echo
echo "Run it:"
echo "  node server.js --url ~/path/to/deck.pdf     # PDF deck"
echo "  node server.js --url docs.google.com        # Google Slides (present mode)"
echo "  node server.js --list-tabs                  # list tabs deck-remote can see"
echo "  npm test                                    # end-to-end self test"
echo
echo "A QR code prints at startup — scan it with your phone (same Wi-Fi)."
