# xiyou-install.ps1  -  西柚英语自动朗读 一键安装
# 检测并安装运行所需的三个组件（已装则跳过）：
#   1) VB-Cable 虚拟声卡        (app 录音走 CABLE Input -> CABLE Output)
#   2) Node.js                   (运行 xiyou-auto.js)
#   3) .NET 6 SDK                (编译/运行 audio-tool 的 xiaoyou-audio.exe)
# 并引导你选择「西柚英语个人版.exe」路径，写入 config.json。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File xiyou-install.ps1
param([switch]$Auto, [switch]$NoOpen)
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgPath = Join-Path $Root 'config.json'

Write-Host ''
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host ' 西柚英语自动朗读  一键安装' -ForegroundColor Cyan
Write-Host '===================================================' -ForegroundColor Cyan

# ---- helper: run a downloaded installer ----
function Invoke-Run($exe, $args) {
  Write-Host ("   运行安装: " + (Split-Path $exe -Leaf)) -ForegroundColor DarkGray
  $p = Start-Process -FilePath $exe -ArgumentList $args -Wait -PassThru -ErrorAction SilentlyContinue
  return ($p -and $p.ExitCode -eq 0)
}

# ---- 1) Node.js ----
function Test-Node { try { $v = cmd /c "node --version" 2>$null; return ($v -match '^v\d') } catch { return $false } }
if (Test-Node) {
  Write-Host '[1/4] Node.js 已安装: ' -NoNewline; cmd /c "node --version" | ForEach-Object { Write-Host $_ }
} else {
  Write-Host '[1/4] Node.js 未安装，准备安装（nodejs.org LTS）...' -ForegroundColor Yellow
  $dest = Join-Path $env:TEMP 'node-install.msi'
  $url = 'https://nodejs.org/dist/latest-v20.x/node-v20.19.0-x64.msi'
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
    Write-Host '   下载完成，开始安装...'
    if (Invoke-Run $dest '/qn') { Write-Host '   Node.js 安装成功。' -ForegroundColor Green }
    else { Write-Host '   Node.js 安装失败，请手动到 https://nodejs.org 下载安装。' -ForegroundColor Red }
  } catch {
    Write-Host '   下载失败，请手动到 https://nodejs.org 下载安装后重试。' -ForegroundColor Red
  }
}

# ---- 2) .NET 6 SDK ----
function Test-Dotnet6 { try { $v = cmd /c "dotnet --version" 2>$null; return ($v -match '^6\.') } catch { return $false } }
if (Test-Dotnet6) {
  Write-Host '[2/4] .NET 6 SDK 已安装: ' -NoNewline; cmd /c "dotnet --version" | ForEach-Object { Write-Host $_ }
} else {
  Write-Host '[2/4] .NET 6 SDK 未安装，准备安装（dotnet 6.0 SDK）...' -ForegroundColor Yellow
  $dest = Join-Path $env:TEMP 'dotnet-sdk6.exe'
  $url = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/6.0.428/dotnet-sdk-6.0.428-win-x64.exe'
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
    Write-Host '   下载完成，开始安装（可能需要以管理员身份）...'
    if (Invoke-Run $dest '/install /quiet /norestart') { Write-Host '   .NET 6 SDK 安装成功。' -ForegroundColor Green }
    else { Write-Host '   .NET 6 SDK 安装失败，请手动到 https://dotnet.microsoft.com/download/dotnet/6.0 下载安装。' -ForegroundColor Red }
  } catch {
    Write-Host '   下载失败，请手动到 https://dotnet.microsoft.com/download/dotnet/6.0 下载安装。' -ForegroundColor Red
  }
}

# ---- 3) VB-Cable ----
function Test-VBCable {
  try {
    # 通过声音设备枚举（MMDevices / PnP）找 CABLE INPUT/OUTPUT
    $devs = Get-CimInstance Win32_SoundDevice -ErrorAction Stop | ForEach-Object { $_.Name }
    if ($devs -match 'CABLE') { return $true }
    return $false
  } catch { return $false }
}
if (Test-VBCable) {
  Write-Host '[3/4] VB-Cable 虚拟声卡已安装。' -ForegroundColor Green
} else {
  Write-Host '[3/4] VB-Cable 虚拟声卡未找到，需要安装。' -ForegroundColor Yellow
  Write-Host '   VB-Cable 是驱动程序，需从官网下载安装（需管理员权限，装后建议重启）。' -ForegroundColor Yellow
  Write-Host '   下载页: https://www.vb-audio.com/Cable/' -ForegroundColor White
  if (-not $NoOpen) { Start-Process 'https://www.vb-audio.com/Cable/' }
  Write-Host '   下载并运行 "VBCABLE_Driver_Pack" 里的 setup.exe（建议以管理员身份）。' -ForegroundColor White
  Write-Host '   安装成功后，请在系统声音设置里确认出现 "CABLE Input" 和 "CABLE Output"。' -ForegroundColor White
  Write-Host '   （按任意键继续...）' -ForegroundColor DarkGray
  if (-not $Auto) { Read-Host | Out-Null }
}

# ---- 4) 选择西柚客户端位置 ----
Write-Host '[4/4] 选择「西柚英语个人版」客户端位置' -ForegroundColor Cyan
$default = 'D:\Program Files\Xiyou\西柚英语个人版.exe'
$exe = $default
if (Test-Path $exe) {
  Write-Host ('   自动检测到: ' + $exe) -ForegroundColor DarkGray
} else {
  Write-Host ('   默认位置没有找到: ' + $exe) -ForegroundColor DarkGray
}
if ($Auto) {
  $exe = $default
  Write-Host '   -Auto 模式采用默认路径。' -ForegroundColor DarkGray
} else {
  Write-Host '   请输入客户端 exe 完整路径（直接回车用默认）:' -ForegroundColor DarkGray
  $in = Read-Host '   > '
  if ($in.Trim()) { $exe = $in.Trim() }
}
if (-not (Test-Path $exe)) {
  Write-Host ('   !! 路径不存在: ' + $exe) -ForegroundColor Red
  Write-Host '   请确认已安装西柚英语，或手动把 config.json 里的 clientExe 改成正确路径。' -ForegroundColor Red
} else {
  Write-Host ('   客户端: ' + $exe) -ForegroundColor Green
}

# ---- 写入 config.json (记录 clientExe，UTF-8 无 BOM) ----
function Write-CfgClientExe($exe) {
  try {
    $cfg = [ordered]@{}
    if (Test-Path $CfgPath) {
      $raw = Get-Content $CfgPath -Raw -Encoding UTF8
      $cfg = $raw | ConvertFrom-Json
    }
    $cfg.clientExe = $exe
    # 保证 config.json 为 UTF-8 无 BOM（脚本依赖）
    $json = $cfg | ConvertTo-Json -Depth 6
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($CfgPath, $json, $enc)
    Write-Host ('   已更新 config.json 的 clientExe: ') -ForegroundColor DarkGray
    Write-Host ('     ' + $exe) -ForegroundColor Green
  } catch {
    Write-Host ('   写 config.json 失败: ' + $_.Exception.Message) -ForegroundColor Red
  }
}
if (Test-Path $exe) { Write-CfgClientExe $exe }

# ---- 提示构建 audio-tool ----
$audioExe = Join-Path $Root 'audio-tool/bin/Release/net6.0/xiaoyou-audio.exe'
if (-not (Test-Path $audioExe)) {
  Write-Host ''
  Write-Host '检测到 audio-tool 尚未编译（缺少 ' -NoNewline
  Write-Host ((Split-Path $audioExe -Leaf)) -NoNewline
  Write-Host '）。' -ForegroundColor DarkGray
  Write-Host '若 .NET 6 已装好，请在项目根目录执行：' -ForegroundColor Yellow
  Write-Host '   dotnet build audio-tool -c Release' -ForegroundColor White
  Write-Host '然后把生成的 xiaoyou-audio.exe / setdev.exe 放好后，再用 启动器 运行。' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '安装/检查完成。' -ForegroundColor Green
Write-Host '若你新增/改动过程序，请重启电脑后再运行 启动器，以避免 VB-Cable 未生效。' -ForegroundColor DarkGray
