# Установка Робо на компьютере ребёнка. Запускать в PowerShell под учётной записью ребёнка.
# Что делает: проверяет Node 22+, ставит Claude Code, зависимости, создаёт рабочие папки,
# копирует пример конфига, делает ярлык на рабочем столе.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Need($cmd) { return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Need node)) { Write-Host "Нужен Node.js 22+: https://nodejs.org" -ForegroundColor Red; exit 1 }
$nodeVer = (node --version).TrimStart("v").Split(".")[0]
if ([int]$nodeVer -lt 22) { Write-Host "Нужен Node.js 22+, сейчас $(node --version)" -ForegroundColor Red; exit 1 }

$claude = "$env:USERPROFILE\.local\bin\claude.exe"
if (-not (Test-Path $claude)) {
  Write-Host "Ставлю Claude Code..."
  irm https://claude.ai/install.ps1 | iex
}
if (-not (Test-Path $claude)) { Write-Host "Claude Code не установился, см. https://code.claude.com/docs/en/setup" -ForegroundColor Red; exit 1 }

Write-Host "Ставлю зависимости..."
npm ci --no-audit --no-fund

New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Robo\workspace" | Out-Null
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Robo\edge-profile" | Out-Null
if (-not (Test-Path "$root\config\config.json")) { Copy-Item "$root\config\config.example.json" "$root\config\config.json" }

& "$PSScriptRoot\make-shortcut.ps1"

Write-Host ""
Write-Host "Готово. Осталось вручную:" -ForegroundColor Green
Write-Host "  1. claude auth login   (ссылку открыть на своём компьютере, код вставить сюда)"
Write-Host "  2. В Roblox Studio: Assistant -> ... -> Manage MCP Servers -> Enable Studio as MCP server"
Write-Host "  3. Поправить config\config.json: PIN, ключи ElevenLabs/Deepgram если нужны"
Write-Host "  4. Ярлык «Робо» на рабочем столе"
