# Robo · Робо

**Voice buddy for kids building games in Roblox Studio.** A child holds a button
and speaks (Russian today, any language Web Speech supports), Robo answers out loud
in simple words and builds the thing right inside the open Roblox Studio place.

Under the hood: a local Node process + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
driving `claude` + the built-in [Roblox Studio MCP server](https://create.roblox.com/docs/studio/mcp)
+ a Microsoft Edge app-mode page for speech recognition and neural TTS. Windows 11 x64.
Tool allowlist and a Luau guard keep the agent away from DataStores, HTTP, purchases
and publishing; a PIN-protected parent panel shows the log, edits the prompt and
approves risky actions. MIT licensed. Docs below are in Russian.

---

Голосовой помощник для ребёнка 7 лет, который строит игру в Roblox Studio.
Ребёнок зажимает кнопку и говорит по-русски, Робо отвечает голосом простыми
словами и строит прямо в открытом месте Studio через её MCP-сервер.

Под капотом: локальный Node-процесс + Claude Agent SDK поверх `claude.exe`
(подписка Claude.ai) + Roblox Studio MCP + страница в Edge для речи.
Windows 11 x64. Архитектура и обоснования в [docs/plan.md](docs/plan.md).

## Установка на компьютере ребёнка

```powershell
git clone https://github.com/nickllama/roblox-voice-buddy C:\Robo
cd C:\Robo
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
claude auth login        # ссылку открыть на своём ПК, код вставить сюда
```

Затем в Roblox Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**.

Ярлык «Робо» на рабочем столе запускает всё: обновление из git, сервер, окно Edge.

### Обновления

Робо сам проверяет GitHub раз в 10 минут и, когда свободен, тянет изменения и
перезапускается. В родительской панели есть «Проверить» и «Обновить сейчас».

- Репозиторий **открытый**: ничего настраивать не нужно.
- Репозиторий **приватный**: на компьютере ребёнка нужен токен только на чтение.
  GitHub → Settings → Developer settings → Fine-grained tokens → доступ к одному
  репозиторию, права Contents: Read-only. Затем один раз:
  `git remote set-url origin https://<ТОКЕН>@github.com/nickllama/roblox-voice-buddy`.

Секреты (PIN, ключи ElevenLabs и Deepgram) живут только в `config\config.json`,
он не попадает в git. Имя ребёнка и личные правки промпта: в `config\prompt.local.md`,
тоже вне git. Перед коммитом `npm run check-secrets` ищет ключи в отслеживаемых файлах.

## Проверка перед первым запуском

1. `scripts\check-studio.ps1` при открытой Studio: в выводе должно быть `"name":"Roblox_Studio","status":"connected"`.
2. `claude auth status` → `authMethod: claude.ai`.
3. Открыть `http://localhost:3777/` в Edge, зажать кнопку, сказать фразу. Если в логе
   `STT в браузере: language-not-supported`, вписать ключ Deepgram в `config\config.json`.
4. В консоли страницы: `speechSynthesis.getVoices().filter(v=>/Russian/.test(v.lang||v.name)).map(v=>v.name)`.
   Если русских «Online (Natural)» нет, включить ElevenLabs в конфиге.

## Родительский режим

`http://localhost:3777/parent` на этом же компьютере или `http://<ip-ребёнка>:3777/parent`
с телефона в домашней сети. PIN в `config\config.json`. Там же: лог, промпт, права,
новая игра, текстовая подсказка Робо, вопросы «разрешить удаление?».

На странице ребёнка родительский режим открывается долгим нажатием в правом верхнем углу.

## Разработка

```bash
npm install
npm run typecheck
npm test             # unit: нарезка предложений, очистка текста, Luau-guard
npm run dev          # сервер с перезапуском при правках
npm run dev:fake     # то же, но вместо Roblox Studio фальшивая Studio из tools/
npm run e2e          # живой прогон: настоящий Claude + фальшивая Studio (нужен вход в Claude Code)
```

Фальшивая Studio (`tools/fake-studio-mcp.mjs`) повторяет имена инструментов настоящей,
держит дерево объектов в памяти и пишет вызовы в файл из `ROBO_FAKE_LOG`. С ней можно
разрабатывать и проверять промпт на Mac или Linux без Roblox.

Конфиг: `config/config.example.json` в git, `config/config.json` локальный.
Промпт: `config/prompt.md` в git, `config/prompt.local.md` правки родителя.

## Лицензия

MIT, см. [LICENSE](LICENSE).

## Структура

```
server/src/agent      сессия Agent SDK, разбор событий, нарезка на предложения
server/src/policy     allowlist инструментов Studio, canUseTool, проверка Luau
server/src/speech     ElevenLabs TTS, Deepgram STT, кэш озвучки
server/src/hotkey.ts  глобальная клавиша push-to-talk (uiohook-napi)
ui/                   страница ребёнка, STT/TTS в браузере, родительская панель
scripts/              install, launch, ярлык, поверх окон, проверка Studio
config/               пример конфига, промпт
tests/                unit-тесты и фразы для прогона
docs/plan.md          план и архитектура
```
