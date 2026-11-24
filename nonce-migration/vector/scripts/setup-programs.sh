#!/usr/bin/env bash
# Produces the Vector program the local validator loads.
#
# The program is not distributed as a binary and is deployed on no cluster, so
# this clones the commit the Rust and TypeScript SDKs in this directory come
# from into .local/vector and runs `cargo build-sbf` on it. The result is
# .local/programs/vector.so, and validator.sh refuses to start without it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PROGRAMS="$LOCAL/programs"
REPO="https://github.com/blueshift-gg/vector.git"
COMMIT="${VECTOR_COMMIT:?set VECTOR_COMMIT to the pinned vector commit}"

# The Vector README builds the program for SBPF v0. The CLI this directory
# installs defaults to SBPF v3, so the build states the version.
BUILD_ARGS=(--arch v0)

# What the binary in $PROGRAMS was built from. A different pin or toolchain
# rebuilds it rather than reusing what is there.
STAMP="$PROGRAMS/.source"
SOURCE="$COMMIT ${BUILD_ARGS[*]}"

mkdir -p "$PROGRAMS"
if [[ -s "$PROGRAMS/vector.so" && "$(cat "$STAMP" 2> /dev/null)" == "$SOURCE" ]]; then
    echo "program already in $PROGRAMS"
    exit 0
fi

# Not `git clone`: in CI the Rust cache restores vector/target before this runs,
# and clone refuses a directory that is not empty.
if [[ ! -d "$LOCAL/vector/.git" ]]; then
    git init --quiet "$LOCAL/vector"
    git -C "$LOCAL/vector" remote add origin "$REPO"
fi
git -C "$LOCAL/vector" fetch --quiet origin "$COMMIT"
git -C "$LOCAL/vector" checkout --quiet "$COMMIT"
echo "building vector from programs/vector at ${COMMIT:0:7}"
cargo build-sbf "${BUILD_ARGS[@]}" --manifest-path "$LOCAL/vector/programs/vector/Cargo.toml" --sbf-out-dir "$PROGRAMS"

[[ -s "$PROGRAMS/vector.so" ]] || {
    echo "expected vector.so in $PROGRAMS" >&2
    exit 1
}
echo "$SOURCE" > "$STAMP"
echo "program ready in $PROGRAMS"
