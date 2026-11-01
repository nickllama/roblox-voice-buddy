# Ярлык «Робо» на рабочем столе: запускает launch.ps1 без окна консоли.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath("Desktop")
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$desktop\Робо.lnk")
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\launch.ps1`""
$s.WorkingDirectory = $root
$s.IconLocation = "$env:SystemRoot\System32\shell32.dll,167"
$s.Save()
Write-Host "Ярлык создан: $desktop\Робо.lnk"
