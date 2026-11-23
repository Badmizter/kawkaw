# KawKaw installer for Windows. Double-click install-windows.bat, or run:
#   powershell -ExecutionPolicy Bypass -File installer\install-win.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ is required. Install the LTS from https://nodejs.org then run this again." -ForegroundColor Red
  Start-Process "https://nodejs.org"; exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Write-Host "Node.js 20+ is required (you have $(node -v))." -ForegroundColor Red; exit 1 }

Write-Host "-> Installing dependencies..."
npm install --omit=dev --no-audit --no-fund

Write-Host "-> Connecting to Claude and setting up auto-start..."
node bridge/src/cli.js setup

Write-Host "-> Starting KawKaw..."
Start-Process -WindowStyle Hidden -FilePath (Get-Command node).Source -ArgumentList "`"$PWD\bridge\src\cli.js`"", "daemon"

Write-Host "-> Building the Premiere panel..."
node installer/package-plugin.js
Start-Process (Join-Path $PWD "dist\KawKaw.ccx") -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Restart Claude, then in Premiere open Window > UXP Plugins > KawKaw." -ForegroundColor Green
Write-Host "Settings: http://127.0.0.1:47321/settings"
