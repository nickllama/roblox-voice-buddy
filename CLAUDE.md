# Робо

Голосовой помощник для ребёнка 7 лет в Roblox Studio. Windows 11, Node 22, TypeScript.
Читать первым: `docs/plan.md` (архитектура и решения).

## Правила
- Язык интерфейса и промптов: русский. Код и комментарии: русский допустим.
- Инструменты Studio: имена и политика в `server/src/policy/rules.ts`. Новый инструмент не добавлять в `ALWAYS_ALLOWED`, если он пишет в игру или аккаунт.
- Всё, что исполняет Luau, проходит `luauGuard.ts`. Список запретов не ослаблять без записи причины в `docs/plan.md`.
- Авторизация Claude: подписка через `claude auth login`, без `--bare`, без API-ключа в репозитории.
- `config/config.json`, `config/prompt.local.md`, `workspace/` не коммитить.
- Перед коммитом: `npm run typecheck && npm test && npm run check-secrets`.
- Репозиторий может быть публичным: личное (имя ребёнка, PIN, ключи) только в неотслеживаемых файлах.
- Коммиты без строк Co-Authored-By и Claude-Session. Автор только `nickllama <nickllama@users.noreply.github.com>`, личную почту в git не писать.
