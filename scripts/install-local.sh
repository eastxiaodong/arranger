#!/bin/bash

# 打包并安装 VSCode 扩展到本地

echo "📦 正在打包扩展..."
cd "$(dirname "$0")/.."

# 编译 TypeScript
npm run compile

# 打包成 VSIX
npx vsce package

# 获取最新的 VSIX 文件
VSIX_FILE=$(ls -t *.vsix | head -1)

if [ -z "$VSIX_FILE" ]; then
  echo "❌ 打包失败，未找到 VSIX 文件"
  exit 1
fi

echo "✅ 打包完成: $VSIX_FILE"
echo "📥 正在安装到 VSCode..."

# 安装到 VSCode
code --install-extension "$VSIX_FILE"

echo "🎉 安装完成！请重新加载 VSCode 窗口 (Cmd+R 或 Ctrl+R)"

