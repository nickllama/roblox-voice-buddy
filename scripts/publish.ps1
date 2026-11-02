# Publishes the open place: brings the Roblox Studio window to the front and sends Alt+P ("Publish to Roblox").
# Called by the server when the parent presses "Publish" in the panel, or approves Robo's request_publish
# question there. Studio's MCP server has no publish tool, and Claude cannot publish any other way:
# the decision is always the parent's.
# First publish of a place opens Studio's dialog (name, description, Create); later ones publish directly.
$shell = New-Object -ComObject WScript.Shell
$proc = Get-Process RobloxStudioBeta, RobloxStudio -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "Roblox Studio window not found"; exit 2 }
if (-not $shell.AppActivate($proc.Id)) { Write-Output "could not bring Roblox Studio to the front"; exit 3 }
Start-Sleep -Milliseconds 400
$shell.SendKeys("%p")
Write-Output "Alt+P sent to `"$($proc.MainWindowTitle)`""
