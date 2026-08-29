# xiyou-launch.ps1  -  Xiyou English homework auto-read launcher (ASCII-safe)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File xiyou-launch.ps1
#   powershell -ExecutionPolicy Bypass -File xiyou-launch.ps1 -Auto
#   powershell -ExecutionPolicy Bypass -File xiyou-launch.ps1 -Run 10
#
# Flow:
#   1. Ensures the Xiyou client is running with --remote-debugging-port (starts it if not).
#   2. Waits for the user to open the specific homework in the Xiyou window.
#   3. When the read-aloud exercise (readingLoudlyV2) is detected, runs the auto-read loop.
#
param([switch]$Auto, [int]$Run = 0)
$ErrorActionPreference = 'Stop'

# Read settings from config.json (single source of truth for device/paths).
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cfg    = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Exe    = $Cfg.clientExe
$Port   = $Cfg.port
$Debug  = "$($Cfg.cdpUrl):$Port/json"
$Node   = 'node'
$AutoScript = Join-Path $Root 'xiyou-auto.js'
$SetDev = Join-Path $Root 'audio-tool\setdev\bin\Release\net6.0\setdev.exe'

function Test-Port { try { $null = Invoke-RestMethod $Debug -TimeoutSec 2; return $true } catch { return $false } }

Write-Host '=== Xiyou English: auto-read launcher ===' -ForegroundColor Cyan

# 0) Ensure the app's microphone is the virtual cable (the app records via its native engine from
#    the OS-default mic; the getUserMedia override does NOT apply). Keep render on the real device
#    (routing render to the cable makes the CABLE Input->Output loopback silent, giving 0 scores).
if ($Cfg.useCableMicOverride -and (Test-Path $SetDev)) {
  try {
    & $SetDev capture $Cfg.cableMicDevice 2>$null | Out-Null
    Write-Host ('Audio: default mic = ' + $Cfg.cableMicDevice) -ForegroundColor DarkGray
  } catch { }
}

# 1) Make sure the client is running with the debug port.
if (-not (Test-Port)) {
  Write-Host 'Client not on the debug port; cleaning stale instances and starting it...' -ForegroundColor Yellow
  Get-Process | Where-Object { $_.ProcessName -like '*西柚*' -or $_.ProcessName -like '*xiyou*' -or $_.Path -like '*Xiyou*' } | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Seconds 2
  Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port"
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port) { $up = $true; break }
  }
  if (-not $up) {
    Write-Host ''
    Write-Host '==== 未能连接西柚客户端（调试端口没有起来）====' -ForegroundColor Red
    Write-Host '请按下面步骤处理后重试：' -ForegroundColor Yellow
    Write-Host '  1) 打开任务管理器，找到所有“西柚英语”进程并【全部结束】。' -ForegroundColor White
    Write-Host '  2) 如果结束不掉，直接重启电脑（最彻底）。' -ForegroundColor White
    Write-Host '  3) 重启后，确认没有手动先打开西柚，再双击本启动器。' -ForegroundColor White
    Write-Host '-------------------------------------------------' -ForegroundColor Red
    exit 1
  }
  Write-Host 'Client started (with debug port).' -ForegroundColor Green
} else {
  Write-Host 'Client already on the debug port.' -ForegroundColor Green
}

Write-Host 'In the Xiyou window, manually open the homework (Word / Sentence / Text reading).' -ForegroundColor Cyan
Write-Host 'If not logged in, log in first; watch mode waits here until a reading screen appears.' -ForegroundColor Cyan

# 2) Auto-read. `watch` is the resume-safe infinite loop: it waits for the client to be up,
#    logs-in readiness, then auto-reads any read-aloud exercise when it opens. This is the most
#    robust path for a fresh install (the user may still be logging in / navigating).
Write-Host 'Starting auto-read (watch mode — waits for the reading screen)...' -ForegroundColor Green
if ($Auto) {
  & $Node $AutoScript watch
} elseif ($Run -gt 0) {
  # For explicit -Run N, wait (bounded) until a reading exercise appears, then run N.
  $found = $false
  for ($i = 0; $i -lt 120; $i++) {
    try { $status = & $Node $AutoScript status 2>$null; if ($status -match '"found"\s*:\s*true') { $found = $true } } catch {}
    if ($found) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $found) { Write-Host 'Reading screen not detected yet. Run:  node xiyou-auto.js watch' -ForegroundColor Red; exit 1 }
  & $Node $AutoScript run $Run
} else {
  & $Node $AutoScript watch
}
