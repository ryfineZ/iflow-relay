#!/bin/bash
set -e

OUTPUT="aigw"
BUNDLE=".sea-bundle.js"
BLOB=".sea-prep.blob"
CONFIG=".sea-config.json"

echo "==> 1/5 打包 JS 文件..."
npx --yes esbuild index.js \
  --bundle \
  --platform=node \
  --outfile="$BUNDLE"

echo "==> 2/5 生成 SEA blob..."
cat > "$CONFIG" << EOF
{
  "main": "$BUNDLE",
  "output": "$BLOB",
  "disableExperimentalSEAWarning": true
}
EOF
node --experimental-sea-config "$CONFIG"

echo "==> 3/5 复制 node 二进制..."
TMP_BIN="/tmp/aigw-sea-$$"
cp "$(which node)" "$TMP_BIN"
chmod +x "$TMP_BIN"
codesign --remove-signature "$TMP_BIN" 2>/dev/null || true

echo "==> 4/5 注入 blob..."
npx --yes postject "$TMP_BIN" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

echo "==> 5/5 签名 (macOS)..."
codesign --sign - "$TMP_BIN" 2>/dev/null || true
mv "$TMP_BIN" "$OUTPUT"

echo "==> 清理临时文件..."
rm -f "$BUNDLE" "$CONFIG" "$BLOB"

echo ""
echo "构建完成！"
echo "  运行:        ./$OUTPUT"
echo "  安装到 PATH: sudo cp $OUTPUT /usr/local/bin/"
