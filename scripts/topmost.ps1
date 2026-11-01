# Makes the window with the given title "always on top".
param([string]$Title = "Robo")
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$HWND_TOPMOST = [IntPtr]::new(-1)
$flags = 0x0001 -bor 0x0002   # SWP_NOSIZE | SWP_NOMOVE
$procs = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*$Title*" }
foreach ($p in $procs) { [Win]::SetWindowPos($p.MainWindowHandle, $HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null }
