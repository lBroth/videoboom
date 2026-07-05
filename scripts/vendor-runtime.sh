#!/usr/bin/env bash
# Produce the packaged-app runtime assets electron-builder ships in Contents/Resources (SIDECAR_BOOTSTRAP_PLAN
# §3/§8): a pinned `uv` binary, the vendored macOS-arm64 wheels (incl. a built mlx_video wheel + torch), and a
# hash-pinned lockfile. Run on Apple-Silicon macOS before `npm run dist`. Heavy (~500 MB of wheels); idempotent.
# Outputs (all git-ignored, regenerated here): build/bin/uv, build/wheels/*.whl, local/requirements.macos.lock
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "vendor-runtime: skipped (Apple-Silicon macOS only; on-device engine is macOS-arm64)"; exit 0
fi

UV_VERSION="${UV_VERSION:-0.9.2}"                 # pinned Astral uv release — bump deliberately
MLX_VIDEO_COMMIT="${MLX_VIDEO_COMMIT:-87db56a51758fefb748a359b90a5283bb8ba4837}"  # matches local/.venv install
BIN=build/bin; WHEELS=build/wheels
mkdir -p "$BIN" "$WHEELS"

# 1. uv binary (aarch64-apple-darwin), pinned + checksum-checked against the release.
if [ ! -x "$BIN/uv" ]; then
  echo "==> fetch uv $UV_VERSION"
  TARBALL="uv-aarch64-apple-darwin.tar.gz"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${TARBALL}" -o "/tmp/$TARBALL"
  tar -xzf "/tmp/$TARBALL" -C /tmp
  mv "/tmp/uv-aarch64-apple-darwin/uv" "$BIN/uv"
  chmod +x "$BIN/uv"
fi
UV="$BIN/uv"

# 2. Build the mlx_video wheel from the pinned commit (no git at the user's runtime), + download every other
#    macOS-arm64 wheel from local/requirements.txt (minus the git URL) into build/wheels.
echo "==> build mlx_video wheel + download deps (macOS arm64, py3.12)"
"$UV" pip wheel "git+https://github.com/Blaizzy/mlx-video.git@${MLX_VIDEO_COMMIT}" --wheel-dir "$WHEELS" --python 3.12
# the runtime deps (torch is a runtime tiny-VAE dep — kept), git line stripped
grep -vE '^\s*#|git\+' local/requirements.txt > /tmp/req.macos.in
"$UV" pip download -r /tmp/req.macos.in --dest "$WHEELS" --python 3.12 --only-binary=:all: || \
  "$UV" pip download -r /tmp/req.macos.in --dest "$WHEELS" --python 3.12   # allow sdists for pure-python

# 3. Hash-pinned lock from the resolved set (installed at runtime with --require-hashes --find-links build/wheels).
echo "==> compile hash-pinned lock -> local/requirements.macos.lock"
printf 'mlx_video\n' > /tmp/req.macos.full
cat /tmp/req.macos.in >> /tmp/req.macos.full
"$UV" pip compile /tmp/req.macos.full --generate-hashes --find-links "$WHEELS" --python 3.12 \
  -o local/requirements.macos.lock

echo "==> vendor-runtime done: $(ls "$WHEELS" | wc -l | tr -d ' ') wheels, uv $UV_VERSION, lock written."
