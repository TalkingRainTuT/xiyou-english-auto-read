#!/usr/bin/env bash
# xiyou-launch.sh  ——  macOS 启动器（理论适配，未实测）
#
# 用法：
#   chmod +x xiyou-launch.sh
#   ./xiyou-launch.sh [--mac-config]
#
# 说明：
#   - Windows 用 xiyou-launch.ps1 / .bat；Mac 用本脚本。
#   - 先手动打开西柚（mac 版）并登录；或让脚本尝试带调试端口启动（视 mac 版是否支持）。
#   - 脚本默认读取 config.json；用 --mac-config 则改用 config.mac.json。
#
set -e
cd "$(dirname "$0")"

CFG=config.json
if [ "$1" = "--mac-config" ]; then CFG=config.mac.json; fi
echo "using config: $CFG"

# 若配置里给了 clientExe，可尝试带调试端口启动（mac 版可能不支持，请自行确认）
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then echo "node 未安装，请先安装 Node.js"; exit 1; fi

echo "请在打开的西柚(mac版)窗口里手动进入朗读/选词作业..."
echo "脚本将进入 watch 模式，自动识别并朗读任何打开的作业。"
node xiyou-auto.js watch
