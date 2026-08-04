#!/usr/bin/env bash
# Guard: cloud stays in its box. http(s) URLs may appear ONLY in the cloud allowlist files; the render
# engine (pipeline/stages/local*), main, preload and renderer must be URL-free — so a resolved-local render
# can never reach the network from our code. Also asserts every host literal in cloud/** is declared in
# src/shared/netAllowlist.ts. Run in CI and locally (npm run check:no-cloud). See DUAL_BACKEND_PLAN.md §6.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1. No EXTERNAL http(s) URLs outside the allowlisted files (localhost/127.0.0.1 dev+sidecar URLs are fine;
#    ignore // and * comment lines).
ALLOW='src/engine/cloud/|src/engine/cost\.ts|src/main/keychain\.ts|src/shared/netAllowlist\.ts'
leaks=$(grep -rInE 'https?://' src --include='*.ts' --include='*.tsx' \
  | grep -vE "$ALLOW" \
  | grep -vE 'https?://(localhost|127\.0\.0\.1|\[?::1\]?)' \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' || true)
if [ -n "$leaks" ]; then
  echo "❌ http(s) URL(s) outside the cloud allowlist (engine/main must be URL-free):"
  echo "$leaks"
  fail=1
fi

# 2. Every host literal used in cloud/** must be declared in netAllowlist.ts.
hosts=$(grep -rhoE "https?://[a-zA-Z0-9.-]+" src/engine/cloud 2>/dev/null | sed -E 's#https?://##' | sort -u || true)
for h in $hosts; do
  base="${h#*.}"  # allow api.replicate.com to match the '*.replicate.delivery'/'api.replicate.com' entries
  if ! grep -qE "'($h|\*\.$base|$base)'" src/shared/netAllowlist.ts; then
    echo "❌ cloud host '$h' is not declared in src/shared/netAllowlist.ts"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✅ check-no-cloud: no cloud URLs leaked outside src/engine/cloud/**; all hosts declared."
fi
exit "$fail"
