#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST_DIR="$ROOT_DIR/native-host"
HOST_SCRIPT="$HOST_DIR/host-linux.sh"
HOST_NAME="com.yisal.waifu2x"
EXTENSION_ID="afckmmcaahgcjeeiebpchipilpccbeha"
TARGET_USER=${SUDO_USER:-${USER:-}}
TARGET_HOME=${HOME:-}

if [ -n "$TARGET_USER" ] && command -v getent >/dev/null 2>&1; then
  USER_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
  if [ -n "$USER_HOME" ]; then
    TARGET_HOME=$USER_HOME
  fi
fi

if [ -z "$TARGET_HOME" ]; then
  echo "无法确定当前浏览器用户的 home 目录。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 node。请先安装 Node.js。"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

if [ ! -x "$ROOT_DIR/vendor/waifu2x-ncnn-vulkan/waifu2x-ncnn-vulkan" ]; then
  if command -v waifu2x-ncnn-vulkan >/dev/null 2>&1; then
    echo "使用系统 PATH 中的 waifu2x-ncnn-vulkan。"
  else
    echo "没有找到 Linux 版 waifu2x-ncnn-vulkan。"
    echo "请下载 waifu2x-ncnn-vulkan-20250915-linux.zip 并解压到："
    echo "  $ROOT_DIR/vendor/waifu2x-ncnn-vulkan"
    echo "也可以安装发行版软件包，确保 waifu2x-ncnn-vulkan 在 PATH 中。"
  fi
fi

write_manifest() {
  dir=$1
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Waifu2x native host for Chrome inline image replacement",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
  if [ "$(id -u)" = "0" ] && [ -n "$TARGET_USER" ] && id "$TARGET_USER" >/dev/null 2>&1; then
    chown "$TARGET_USER":"$(id -gn "$TARGET_USER")" "$dir" "$dir/$HOST_NAME.json" 2>/dev/null || true
  fi
  echo "已写入：$dir/$HOST_NAME.json"
}

write_manifest "$TARGET_HOME/.config/google-chrome/NativeMessagingHosts"
write_manifest "$TARGET_HOME/.config/chromium/NativeMessagingHosts"

echo "完成。现在在 chrome://extensions/ 重新加载这个扩展。"
