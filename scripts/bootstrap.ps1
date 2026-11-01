# Robo one-line installer for Windows 11. Run in PowerShell under the child's Windows account:
#   irm https://raw.githubusercontent.com/nickllama/roblox-voice-buddy/main/scripts/bootstrap.ps1 | iex
# What it does: installs Git and Node.js through winget if they are missing, clones the repository
# into C:\Robo (or $env:ROBO_DIR), runs scripts\install.ps1 (Claude Code, dependencies, folders,
# shortcut), asks for the child's language and the parent PIN, signs in to Claude, checks Roblox
# Studio and launches Robo. Safe to run again: it updates instead of reinstalling.
$ErrorActionPreference = "Stop"
$repo = "https://github.com/nickllama/roblox-voice-buddy"
$dir = if ($env:ROBO_DIR) { $env:ROBO_DIR } else { "C:\Robo" }

function Say($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Have($cmd) { return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function InstallWithWinget($id, $name) {
  if (-not (Have winget)) { throw "winget is not available. Install $name by hand and run this command again." }
  Say "Installing $name"
  winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent
  # 0x8A15002B: already installed, that is fine too.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget could not install $name (exit code $LASTEXITCODE)" }
  RefreshPath
}

try {
  Say "Checking Git and Node.js"
  if (-not (Have git)) { InstallWithWinget "Git.Git" "Git" }
  $needNode = -not (Have node)
  if (-not $needNode) {
    $major = [int]((node --version).TrimStart("v").Split(".")[0])
    if ($major -lt 22) { $needNode = $true }
  }
  if ($needNode) { InstallWithWinget "OpenJS.NodeJS.LTS" "Node.js" }
  RefreshPath
  if (-not (Have git) -or -not (Have node)) {
    throw "Git or Node.js is still not on PATH. Open a new PowerShell window and run the same command again."
  }

  Say "Getting the code into $dir"
  if (Test-Path "$dir\.git") {
    git -C $dir pull --ff-only
  } else {
    git clone $repo $dir
  }
  Set-Location $dir

  Say "Installing Robo"
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\scripts\install.ps1" -NoSummary
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed (exit code $LASTEXITCODE)" }

  Say "Settings"
  $cfgPath = "$dir\config\config.json"
  $cfg = ((Get-Content $cfgPath -Raw) -replace '^﻿', '') | ConvertFrom-Json
  $lang = Read-Host "Child's language as a BCP-47 tag (en-US, ru-RU, de-DE, ...) [$($cfg.language)]"
  if ($lang) { $cfg.language = $lang.Trim() }
  if ($cfg.parentPin -eq "1234") {
    $pin = Read-Host "Parent PIN for the /parent panel (digits, Enter keeps 1234)"
    if ($pin) { $cfg.parentPin = $pin.Trim() }
  }
  $json = $cfg | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Language: $($cfg.language). Keys for ElevenLabs or Deepgram go into $cfgPath later if needed."

  Say "Claude sign-in"
  $claude = "$env:USERPROFILE\.local\bin\claude.exe"
  $status = ""
  try { $status = (& $claude auth status 2>$null) -join "" } catch {}
  if ($status -match '"loggedIn":\s*true') {
    Write-Host "Already signed in."
  } else {
    Write-Host "Open the link on your own computer, sign in with your Claude account, paste the code here."
    & $claude auth login
    try { $status = (& $claude auth status 2>$null) -join "" } catch {}
    if ($status -notmatch '"loggedIn":\s*true') { Write-Host "Not signed in yet. Run later: claude auth login" -ForegroundColor Yellow }
  }

  Say "Roblox Studio"
  if (-not (Test-Path "$env:LOCALAPPDATA\Roblox\mcp.bat")) {
    Write-Host "Studio's MCP launcher was not found at $env:LOCALAPPDATA\Roblox\mcp.bat. Install or update Roblox Studio." -ForegroundColor Yellow
  }
  Write-Host "Once, inside Roblox Studio: Assistant -> ... -> Manage MCP Servers -> Enable Studio as MCP server."
  Write-Host "Robo's screen shows whether Studio is connected."

  Say "Starting Robo"
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\scripts\launch.ps1"
  Write-Host ""
  Write-Host "Done. Parent panel: http://localhost:$($cfg.port)/parent (PIN). Log: $dir\robo.log. Desktop shortcut: Robo." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Fix the cause and run the same command again; finished steps are skipped."
  exit 1
}
