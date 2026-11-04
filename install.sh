#!/usr/bin/env bash
# deck-remote installer — macOS and Linux, no sudo required.
#
# Installs, in order:
#   1. Node.js >= 18 (via nvm, only if missing)
#   2. npm dependencies
#   3. llama.cpp (prebuilt binary from the llama.cpp releases)
#   4. Gemma 4 E2B vision model (~4.4 GB, one time, resumable)
#   5. built-in OCR fallback cache + a live smoke test of Gemma
#
# Idempotent: re-run any time. Safe after scp'ing the folder from another
# OS/arch (native modules are always reinstalled cleanly).
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

LLAMA_TAG="${LLAMA_TAG:-b12078}"
MODEL_REPO="google/gemma-4-E2B-it-qat-q4_0-gguf"
MODEL_FILE="gemma-4-E2B_q4_0-it.gguf"
MMPROJ_FILE="gemma-4-E2B-it-mmproj.gguf"
MODEL_SIZE=3349516256
MMPROJ_SIZE=986833664

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
  # remember nvm's bin dir so the ./deck-remote launcher works in
  # non-interactive shells (nvm only loads in interactive ones)
  dirname "$(command -v node)" > .node-bin-dir
  say "Node.js $(node -v) installed via nvm"
fi

# ---- 2. dependencies ------------------------------------------------------
say "Installing dependencies (npm install)…"
rm -rf node_modules
npm install --no-audit --no-fund || die "npm install failed (need internet)"

node -e "['ws','sharp','qrcode','qrcode-terminal','tesseract.js'].forEach(require); console.log('modules load ok')" \
  || die "module check failed — try: rm -rf node_modules && npm install"

# ---- 3. llama.cpp ----------------------------------------------------------
install_llama() {
  if command -v llama-server >/dev/null 2>&1; then
    say "Using system llama-server: $(command -v llama-server)"
    return 0
  fi
  if [ -e "tools/llama.cpp/llama-server" ]; then
    say "llama.cpp already installed under tools/"
    return 0
  fi
  local sys arch asset
  sys="$(uname -s)"; arch="$(uname -m)"
  case "$sys/$arch" in
    Darwin/arm64)  asset=macos-arm64 ;;
    Darwin/x86_64) asset=macos-x64 ;;
    Linux/x86_64)  asset=ubuntu-x64 ;;
    Linux/aarch64) asset=ubuntu-arm64 ;;
    *) warn "no prebuilt llama.cpp for $sys $arch"; return 1 ;;
  esac
  say "Downloading llama.cpp ($asset, ~20 MB)…"
  mkdir -p tools
  curl -fL --retry 3 --progress-bar \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-${asset}.tar.gz" \
    | tar xz -C tools || return 1
  [ -x "tools/llama-${LLAMA_TAG}/llama-server" ] || { warn "unexpected llama.cpp tarball layout"; return 1; }
  ln -sfn "llama-${LLAMA_TAG}" tools/llama.cpp
  say "llama.cpp installed → tools/llama.cpp/llama-server"
}

llama_works() {
  if command -v llama-server >/dev/null 2>&1; then return 0; fi
  local bin
  bin="$(readlink -f tools/llama.cpp/llama-server 2>/dev/null || true)"
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  "$bin" --version >/dev/null 2>&1
}

build_llama() {
  say "Building llama.cpp from source (needs cmake + a C++ compiler)…"
  command -v cmake >/dev/null 2>&1 || { warn "cmake not found — install cmake (brew install cmake / apt install cmake) and re-run"; return 1; }
  rm -rf tools/llama-src
  git clone --depth 1 https://github.com/ggml-org/llama.cpp tools/llama-src || return 1
  ( cd tools/llama-src \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF >/dev/null \
    && cmake --build build --target llama-server -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" ) || return 1
  mkdir -p tools/llama.cpp
  ln -sf "$(pwd)/tools/llama-src/build/bin/llama-server" tools/llama.cpp/llama-server
  say "built llama-server from source"
}

if ! install_llama || ! llama_works; then
  build_llama || die "could not install llama.cpp — install llama-server on your PATH and re-run"
fi
llama_works || die "llama-server is not runnable on this system"

# ---- 4. Gemma 4 E2B model (~4.4 GB, resumable) -----------------------------
fsize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }

fetch_model() { # $1=file $2=size $3=label
  mkdir -p models
  if [ -f "models/$1" ] && [ "$(fsize "models/$1")" -ge "$(($2 * 99 / 100))" ]; then
    say "$3 already downloaded"
    return 0
  fi
  say "Downloading $3 ($(($2 / 1000000)) MB — resumable, one time)…"
  curl -fL -C - --retry 5 --retry-delay 3 --progress-bar \
    -o "models/$1.part" "https://huggingface.co/${MODEL_REPO}/resolve/main/$1" \
    || { rm -f "models/$1.part"; return 1; }
  mv "models/$1.part" "models/$1"
}

fetch_model "$MODEL_FILE" "$MODEL_SIZE" "Gemma 4 E2B model" || die "model download failed"
fetch_model "$MMPROJ_FILE" "$MMPROJ_SIZE" "Gemma vision projector" || die "mmproj download failed"

# ---- 5. OCR fallback cache (fast, keeps deck-remote usable without Gemma) --
say "Preparing OCR fallback cache…"
node scripts/warm-ocr.js || warn "OCR fallback not cached (Gemma is the primary describer anyway)"

# ---- 6. smoke test: load Gemma, describe a synthetic slide -----------------
say "Smoke-testing Gemma (first model load takes a minute)…"
if [ -f .node-bin-dir ]; then export PATH="$(cat .node-bin-dir):$PATH"; fi
if node scripts/vlm-smoke.js; then
  say "Gemma 4 E2B ready."
else
  warn "Gemma smoke test failed — deck-remote will still run with built-in OCR fallback."
fi

say "Install complete."
echo
echo "Run it:"
echo "  ./deck-remote --url ~/path/to/deck.pdf     # PDF deck"
echo "  ./deck-remote --url docs.google.com        # Google Slides (present mode)"
echo "  ./deck-remote --list-tabs                  # list tabs deck-remote can see"
echo "  bash scripts/test.sh                       # end-to-end self test (no AI needed)"
echo
echo "A QR code prints at startup — scan it with your phone (same Wi-Fi)."
echo "First launch loads the model (~1 min) before slide descriptions appear."
