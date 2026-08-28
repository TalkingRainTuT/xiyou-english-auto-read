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

function Test-Port { try { $null = Invoke-RestMethod $Debug -TimeoutSec 2; return $true } catch { return $false } }

Write-Host '=== Xiyou English: auto-read launcher ===' -ForegroundColor Cyan

# 1) Make sure the client is running with the debug port.
if (-not (Test-Port)) {
  Write-Host 'Client not on the debug port; starting it now...' -ForegroundColor Yellow
  Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port"
  $up = $false
  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port) { $up = $true; break }
  }
  if (-not $up) { Write-Host 'Client did not start. Run this as Administrator, or open Xiyou manually and retry.' -ForegroundColor Red; exit 1 }
  Write-Host 'Client started (with debug port).' -ForegroundColor Green
} else {
  Write-Host 'Client already on the debug port.' -ForegroundColor Green
}

Write-Host 'In the Xiyou window, manually open the homework (Word / Text reading).' -ForegroundColor Cyan
Write-Host 'This launcher will auto-start reading once the read-aloud screen is detected.' -ForegroundColor Cyan

# 2) Poll until a read-aloud exercise is open (any of the 3 types).
$found = $false
for ($i = 0; $i -lt 120; $i++) {
  try {
    $status = & $Node $AutoScript status 2>$null
    if ($status -match '"found"\s*:\s*true') { $found = $true }
  } catch {}
  if ($found) { break }
  Start-Sleep -Seconds 2
}

if (-not $found) {
  Write-Host 'Read-aloud screen not detected. Make sure the homework (Word / Sentence / Text reading) is open in the Xiyou window.' -ForegroundColor Red
  Write-Host 'You can also run:  node xiyou-auto.js watch' -ForegroundColor DarkGray
  exit 1
}

# 3) Auto-read. Default is `watch`: it keeps looping forever and resumes any exercise that
#    is opened (so pausing / re-entering does not require restarting the launcher).
Write-Host 'Read-aloud screen detected. Starting auto-read (watch mode)...' -ForegroundColor Green
if ($Auto) {
  & $Node $AutoScript watch
} elseif ($Run -gt 0) {
  & $Node $AutoScript run $Run
} else {
  & $Node $AutoScript watch
}
