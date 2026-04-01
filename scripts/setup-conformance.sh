#!/bin/bash
# Sparse-clone Angular's compliance test fixtures at a specific version.
# Usage: bash scripts/setup-conformance.sh [version]
# Default: latest release from GitHub

set -e

if [ -z "$1" ]; then
  # Auto-detect latest: keep full tag name (may have v prefix)
  VERSION=$(curl -sL https://api.github.com/repos/angular/angular/releases/latest | grep -o '"tag_name": "[^"]*"' | sed 's/"tag_name": "//;s/"//')
  echo "Detected latest Angular release: $VERSION"
else
  VERSION=$1
fi
TARGET=${ANGULAR_SOURCE_DIR:-.angular-conformance}

if [ -d "$TARGET" ]; then
  echo "Removing existing $TARGET..."
  rm -rf "$TARGET"
fi

echo "Cloning Angular $VERSION compliance fixtures into $TARGET..."
# Try the version as-is first, then with/without v prefix
if ! git clone --depth 1 --branch "$VERSION" --filter=blob:none --sparse \
  https://github.com/angular/angular.git "$TARGET" 2>/dev/null; then
  # Try with v prefix if not present, or without if present
  if [[ "$VERSION" == v* ]]; then
    ALT_VERSION="${VERSION#v}"
  else
    ALT_VERSION="v$VERSION"
  fi
  echo "Tag $VERSION not found, trying $ALT_VERSION..."
  git clone --depth 1 --branch "$ALT_VERSION" --filter=blob:none --sparse \
    https://github.com/angular/angular.git "$TARGET"
fi

cd "$TARGET"
git sparse-checkout set packages/compiler-cli/test/compliance/test_cases

echo "Done. $(find packages/compiler-cli/test/compliance/test_cases -name '*.ts' | wc -l | tr -d ' ') test files downloaded."
echo "Run: ANGULAR_SOURCE_DIR=$TARGET npx vitest run angular-compiler/src/lib/conformance.spec.ts"
