#!/usr/bin/env bash
# Copies the Ed25519 part of the Vector TypeScript SDK out of the pinned commit
# into ts/web3js-v3/src/client/.
#
# The package @blueshift-gg/vector is not on npm, and a git dependency on sdk/ts
# would need its tsc build to run at install time, which pnpm does not do for a
# package without a `prepare` script. Copying the sources keeps `pnpm install`
# plain. When the package is published, this script and the copy go.
#
# Only the files the Ed25519 scheme imports are copied. The SDK's index and its
# offline verifier import every scheme, and with them the post-quantum
# libraries; the examples need neither.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
REPO="https://github.com/blueshift-gg/vector.git"
COMMIT="${VECTOR_COMMIT:?set VECTOR_COMMIT to the pinned vector commit}"
DEST="$ROOT/ts/web3js-v3/src/client"
FILES=(bytes.ts scheme.ts instructions.ts digest.ts transaction.ts schemes/ed25519.ts)

if [[ ! -d "$LOCAL/vector/.git" ]]; then
    git clone --quiet "$REPO" "$LOCAL/vector"
fi
git -C "$LOCAL/vector" fetch --quiet origin "$COMMIT"
git -C "$LOCAL/vector" checkout --quiet "$COMMIT"

rm -rf "$DEST"
mkdir -p "$DEST/schemes"
for file in "${FILES[@]}"; do
    cp "$LOCAL/vector/sdk/ts/src/$file" "$DEST/$file"
done
# The SDK is MIT licensed; its notice travels with the copy.
cp "$LOCAL/vector/LICENSE" "$DEST/LICENSE"
cat > "$DEST/index.ts" <<HEADER
/**
 * The Ed25519 part of the Vector TypeScript SDK, copied from sdk/ts/src in
 * blueshift-gg/vector at ${COMMIT:0:7}.
 *
 * Regenerate with \`just vendor-ts-client\`. Do not edit by hand.
 */

export * from './scheme.js';
export * from './instructions.js';
export * from './digest.js';
export * from './transaction.js';
export * from './schemes/ed25519.js';
HEADER
echo "vendored sdk/ts at ${COMMIT:0:7} into $DEST"
