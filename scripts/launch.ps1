# Launches Robo: update from git, hidden server, Edge window next to Studio, always on top.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = 3777
$cfg = $null
try { $cfg = Get-Content "$root\config\config.json" -Raw | ConvertFrom-Json; if ($cfg.port) { $port = $cfg.port } } catch {}

# Window geometry from config.json (window: width, height, anchor, margin), defaults match config.example.json.
$win = @{ width = 340; height = 460; anchor = "bottom-left"; margin = 10 }
if ($cfg -and $cfg.window) { foreach ($k in "width", "height", "anchor", "margin") { if ($null -ne $cfg.window.$k -and "$($cfg.window.$k)" -ne "") { $win[$k] = $cfg.window.$k } } }
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [int]$win.width; $h = [int]$win.height; $m = [int]$win.margin
switch ("$($win.anchor)") {
  "top-left"     { $x = $wa.Left + $m;       $y = $wa.Top + $m }
  "top-right"    { $x = $wa.Right - $w - $m; $y = $wa.Top + $m }
  "bottom-right" { $x = $wa.Right - $w - $m; $y = $wa.Bottom - $h - $m }
  default        { $x = $wa.Left + $m;       $y = $wa.Bottom - $h - $m }
}

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

# Edge window in app mode, separate profile, in the configured corner.
$edge = "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$profile = "$env:LOCALAPPDATA\Robo\edge-profile"
Start-Process -FilePath $edge -ArgumentList @(
  "--app=http://localhost:$port/",
  "--user-data-dir=$profile",
  "--window-size=$w,$h",
  "--window-position=$x,$y",
  "--no-first-run",
  "--autoplay-policy=no-user-gesture-required"
)

# Edge keeps the last geometry per profile; enforce ours and put the window on top.
& "$PSScriptRoot\topmost.ps1" -Title "Robo" -X $x -Y $y -W $w -H $h
