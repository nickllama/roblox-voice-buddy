# Запуск Робо: обновление из git, сервер скрыто, окно Edge рядом со Studio, поверх окон.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Обновление кода, если есть сеть и репозиторий.
if (Test-Path "$root\.git") {
  $before = git rev-parse HEAD
  git pull --ff-only 2>$null | Out-Null
  $after = git rev-parse HEAD
  if ($before -ne $after) { npm ci --no-audit --no-fund 2>$null | Out-Null }
}

$port = 3777
try { $cfg = Get-Content "$root\config\config.json" -Raw | ConvertFrom-Json; if ($cfg.port) { $port = $cfg.port } } catch {}

# Сервер уже запущен?
$alive = $false
try { $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2; $alive = $r.StatusCode -eq 200 } catch {}
if (-not $alive) {
  Start-Process -FilePath "node" -ArgumentList "node_modules\tsx\dist\cli.mjs server\src\index.ts" -WorkingDirectory $root -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { break } } catch {}
  }
}

# Окно Edge в режиме приложения, отдельный профиль, справа от Studio.
$edge = "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$profile = "$env:LOCALAPPDATA\Robo\edge-profile"
$screenW = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width
if (-not $screenW) { Add-Type -AssemblyName System.Windows.Forms; $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width }
$w = 440; $x = $screenW - $w - 10
Start-Process -FilePath $edge -ArgumentList @(
  "--app=http://localhost:$port/",
  "--user-data-dir=$profile",
  "--window-size=$w,900",
  "--window-position=$x,40",
  "--no-first-run",
  "--autoplay-policy=no-user-gesture-required"
)

Start-Sleep -Seconds 3
& "$PSScriptRoot\topmost.ps1" -Title "Робо"
