# Installs Robo on the child's computer. Run in PowerShell under the child's Windows account.
# What it does: checks Node 22+, installs Claude Code and dependencies, creates working folders,
# copies the example config, creates a desktop shortcut. -NoSummary skips the closing checklist
# (bootstrap.ps1 does those steps itself).
param([switch]$NoSummary)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Need($cmd) { return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Need node)) { Write-Host "Node.js 22+ is required: https://nodejs.org" -ForegroundColor Red; exit 1 }
$nodeVer = (node --version).TrimStart("v").Split(".")[0]
if ([int]$nodeVer -lt 22) { Write-Host "Node.js 22+ is required, found $(node --version)" -ForegroundColor Red; exit 1 }

$claude = "$env:USERPROFILE\.local\bin\claude.exe"
if (-not (Test-Path $claude)) {
  Write-Host "Installing Claude Code..."
  irm https://claude.ai/install.ps1 | iex
}
if (-not (Test-Path $claude)) { Write-Host "Claude Code did not install, see https://code.claude.com/docs/en/setup" -ForegroundColor Red; exit 1 }

Write-Host "Installing dependencies..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci failed" -ForegroundColor Red; exit 1 }
# Stamp: launch.ps1 and restart.mjs reinstall only when package-lock.json changes.
Set-Content "$root\node_modules\.robo-lock-hash" ((Get-FileHash "$root\package-lock.json" -Algorithm SHA1).Hash.ToLower()) -NoNewline

New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Robo\workspace" | Out-Null
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Robo\edge-profile" | Out-Null
if (-not (Test-Path "$root\config\config.json")) { Copy-Item "$root\config\config.example.json" "$root\config\config.json" }

& "$PSScriptRoot\make-shortcut.ps1"

if ($NoSummary) { exit 0 }
Write-Host ""
Write-Host "Done. Remaining manual steps:" -ForegroundColor Green
Write-Host "  1. claude auth login   (open the link on your own computer, paste the code here)"
Write-Host "  2. In Roblox Studio: Assistant -> ... -> Manage MCP Servers -> Enable Studio as MCP server"
Write-Host "  3. Edit config\config.json: language, PIN, ElevenLabs/Deepgram keys if needed"
Write-Host "  4. The 'Robo' shortcut is on the desktop"
