#!/bin/bash
# Sparse-clone Angular's compliance test fixtures at a specific version.
# Usage: bash scripts/setup-conformance.sh [version]
# Default version: 21.0.0

set -e

VERSION=${1:-21.0.0}
TARGET=${ANGULAR_SOURCE_DIR:-.angular-conformance}

if [ -d "$TARGET" ]; then
  echo "Removing existing $TARGET..."
  rm -rf "$TARGET"
fi

echo "Cloning Angular $VERSION compliance fixtures into $TARGET..."
git clone --depth 1 --branch "$VERSION" --filter=blob:none --sparse \
  https://github.com/angular/angular.git "$TARGET"

cd "$TARGET"
git sparse-checkout set packages/compiler-cli/test/compliance/test_cases

echo "Done. $(find packages/compiler-cli/test/compliance/test_cases -name '*.ts' | wc -l | tr -d ' ') test files downloaded."
echo "Run: ANGULAR_SOURCE_DIR=$TARGET npx vitest run angular-compiler/src/lib/conformance.spec.ts"
