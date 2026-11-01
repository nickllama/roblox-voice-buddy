# Checks that Claude Code can see the Roblox Studio MCP server.
# Studio must be open with its MCP server enabled.
$bat = "$env:LOCALAPPDATA\Roblox\mcp.bat"
if (-not (Test-Path $bat)) { Write-Host "No $bat. Update Roblox Studio." -ForegroundColor Red; exit 1 }
$mcp = '{"mcpServers":{"Roblox_Studio":{"command":"cmd.exe","args":["/c","' + ($bat -replace '\\','\\\\') + '"]}}}'
& "$env:USERPROFILE\.local\bin\claude.exe" -p "Call list_roblox_studios and name the open place in one sentence." `
  --mcp-config $mcp --strict-mcp-config `
  --allowedTools "mcp__Roblox_Studio__list_roblox_studios" `
  --output-format stream-json --verbose
