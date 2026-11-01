# Places the Edge window with the given title (position and size when given) and keeps it above other windows.
# Waits up to WaitSec for the window to appear. Edge remembers its last geometry per profile, so launch.ps1
# calls this on every start to enforce the size and corner from config.json.
param([string]$Title = "Robo", [int]$X = -1, [int]$Y = -1, [int]$W = 0, [int]$H = 0, [int]$WaitSec = 10)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$HWND_TOPMOST = [IntPtr]::new(-1)
$SWP_NOSIZE = 0x0001; $SWP_NOMOVE = 0x0002; $SWP_SHOWWINDOW = 0x0040
$flags = $SWP_SHOWWINDOW
if ($W -le 0 -or $H -le 0) { $flags = $flags -bor $SWP_NOSIZE }
if ($X -lt 0 -or $Y -lt 0) { $flags = $flags -bor $SWP_NOMOVE }

$deadline = (Get-Date).AddSeconds($WaitSec)
$done = $false
while (-not $done -and (Get-Date) -lt $deadline) {
  $procs = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" }
  foreach ($p in $procs) {
    [Win]::SetWindowPos($p.MainWindowHandle, $HWND_TOPMOST, $X, $Y, $W, $H, $flags) | Out-Null
    $done = $true
  }
  if (-not $done) { Start-Sleep -Milliseconds 500 }
}
