# Launches Robo: update from git, hidden server, Edge window next to Studio, always on top.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = 3777
try { $cfg = Get-Content "$root\config\config.json" -Raw | ConvertFrom-Json; if ($cfg.port) { $port = $cfg.port } } catch {}

# Is the server already running? Then it updates itself; we only open the window.
$alive = $false
try { $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2; $alive = $r.StatusCode -eq 200 } catch {}

if (-not $alive) {
  # Update the code if there is a network and a repository.
  if (Test-Path "$root\.git") { git pull --ff-only 2>$null | Out-Null }

  # Install dependencies when node_modules does not match package-lock.json (stamp written after a successful install).
  $lockHash = (Get-FileHash "$root\package-lock.json" -Algorithm SHA1).Hash.ToLower()
  $stamp = "$root\node_modules\.robo-lock-hash"
  $have = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
  if ($have -ne $lockHash) {
    npm ci --no-audit --no-fund 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Set-Content $stamp $lockHash -NoNewline }
  }

  Start-Process -FilePath "node" -ArgumentList "node_modules\tsx\dist\cli.mjs server\src\index.ts" -WorkingDirectory $root -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { break } } catch {}
  }
}

# Edge window in app mode, separate profile, to the right of Studio.
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
& "$PSScriptRoot\topmost.ps1" -Title "Robo"
