#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export CLANG_MODULE_CACHE_PATH="$PROJECT_DIR/.build/ModuleCache"
cd "$PROJECT_DIR"
swift build --disable-sandbox -c release
BIN_DIR=$(cd "$PROJECT_DIR" && swift build --disable-sandbox -c release --show-bin-path)
APP_DIR="$PROJECT_DIR/dist/LoopCanvas.app"
ARCHIVE_PATH="$PROJECT_DIR/dist/LoopCanvas-release.zip"
PACKAGE_STAGE_DIR=$(mktemp -d /private/tmp/loopcanvas-package.XXXXXX)
STAGED_APP="$PACKAGE_STAGE_DIR/LoopCanvas.app"
VERIFY_DIR="$PACKAGE_STAGE_DIR/verify"
trap 'rm -rf "$PACKAGE_STAGE_DIR"' EXIT

mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources" "$PROJECT_DIR/dist"
cp "$BIN_DIR/LoopCanvas" "$STAGED_APP/Contents/MacOS/LoopCanvas"
cp "$PROJECT_DIR/Resources/Info.plist" "$STAGED_APP/Contents/Info.plist"
cp -R "$PROJECT_DIR/plugins" "$STAGED_APP/Contents/Resources/plugins"
chmod 755 "$STAGED_APP/Contents/MacOS/LoopCanvas"
xattr -cr "$STAGED_APP"
codesign --force --sign - --timestamp=none "$STAGED_APP"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"

rm -f "$ARCHIVE_PATH"
ditto --norsrc -c -k --keepParent "$STAGED_APP" "$ARCHIVE_PATH"
mkdir -p "$VERIFY_DIR"
ditto -x -k "$ARCHIVE_PATH" "$VERIFY_DIR"
xattr -cr "$VERIFY_DIR/LoopCanvas.app"
codesign --verify --deep --strict --verbose=2 "$VERIFY_DIR/LoopCanvas.app"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$APP_DIR/Contents/_CodeSignature"
cp "$STAGED_APP/Contents/MacOS/LoopCanvas" "$APP_DIR/Contents/MacOS/LoopCanvas"
cp "$STAGED_APP/Contents/Info.plist" "$APP_DIR/Contents/Info.plist"
cp -R "$STAGED_APP/Contents/Resources/plugins" "$APP_DIR/Contents/Resources/plugins"
cp "$STAGED_APP/Contents/_CodeSignature/CodeResources" "$APP_DIR/Contents/_CodeSignature/CodeResources"
chmod 755 "$APP_DIR/Contents/MacOS/LoopCanvas"
xattr -cr "$APP_DIR"

echo "$APP_DIR"
echo "$ARCHIVE_PATH"
