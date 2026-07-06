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

UV_VERSION="${UV_VERSION:-0.11.17}"               # pinned Astral uv release — bump deliberately
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

# 2. Build a wheelhouse: mlx_video from its pinned git commit (no git at the user's runtime) + every runtime
#    dep as a macOS-arm64 wheel. uv has no `pip wheel`, so use pip's (python3.12 -m pip wheel), which builds
#    the git/pure-python packages and downloads the binary wheels (torch, mlx, ncnn) into build/wheels.
echo "==> build wheelhouse (mlx_video @ pinned commit + deps, macOS arm64, py3.12)"
grep -vE '^\s*#|git\+' local/requirements.txt > /tmp/req.macos.in   # runtime deps, git line stripped (torch kept)
python3.12 -m pip wheel \
  "git+https://github.com/Blaizzy/mlx-video.git@${MLX_VIDEO_COMMIT}" \
  -r /tmp/req.macos.in --wheel-dir "$WHEELS"

# 3. Hash-pinned lock resolved from the local wheelhouse (installed at runtime with --require-hashes).
echo "==> compile hash-pinned lock -> local/requirements.macos.lock"
{ echo mlx_video; cat /tmp/req.macos.in; } > /tmp/req.macos.full
"$UV" pip compile /tmp/req.macos.full --generate-hashes --find-links "$WHEELS" --no-index --python 3.12 \
  -o local/requirements.macos.lock

echo "==> vendor-runtime done: $(ls "$WHEELS" | wc -l | tr -d ' ') wheels, uv $UV_VERSION, lock written."
