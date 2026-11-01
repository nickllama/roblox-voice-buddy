# Robo

Voice buddy for a 7-year-old child in Roblox Studio. Windows 11, Node 22, TypeScript.
Read first: `docs/plan.md` (architecture and decisions).

## Rules
- Language: English for code, comments, docs, commit messages and the parent panel. Child-facing strings (on-screen statuses, spoken system phrases) are localized by `config.language` in `server/src/i18n.ts` and `ui/i18n.js`; keep `en` and `ru` in sync when adding a phrase.
- Studio tools: names and policy live in `server/src/policy/rules.ts`. Do not add a new tool to `ALWAYS_ALLOWED` if it writes to the game or the account.
- Everything that executes Luau goes through `luauGuard.ts`. Do not loosen the deny list without recording the reason in `docs/plan.md`.
- Claude auth: subscription via `claude auth login`, no `--bare`, no API key in the repository.
- `config/config.json`, `config/prompt.local.md`, `workspace/` are not committed.
- Before committing: `npm run typecheck && npm test && npm run check-secrets`.
- The repository is public: personal data (child's name, PIN, keys) only in untracked files.
- Commits without Co-Authored-By or Claude-Session lines. Author only `nickllama <nickllama@users.noreply.github.com>`; never put a personal email in git.
