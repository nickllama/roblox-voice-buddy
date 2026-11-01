# Проверка, что Claude Code видит MCP-сервер Roblox Studio.
# Studio должна быть открыта с включённым MCP-сервером.
$bat = "$env:LOCALAPPDATA\Roblox\mcp.bat"
if (-not (Test-Path $bat)) { Write-Host "Нет $bat. Обновите Roblox Studio." -ForegroundColor Red; exit 1 }
$mcp = '{"mcpServers":{"Roblox_Studio":{"command":"cmd.exe","args":["/c","' + ($bat -replace '\\','\\\\') + '"]}}}'
& "$env:USERPROFILE\.local\bin\claude.exe" -p "Вызови list_roblox_studios и назови открытое место одним предложением." `
  --mcp-config $mcp --strict-mcp-config `
  --allowedTools "mcp__Roblox_Studio__list_roblox_studios" `
  --output-format stream-json --verbose
