# Робо: архитектура

Архитектура и обоснование решений. Составлено по официальной документации
Claude Code и Agent SDK (code.claude.com), Roblox Studio MCP (create.roblox.com),
Microsoft Edge и Web Speech API. Пункты, которые документация не подтверждает,
помечены «проверить на машине».


---

## 1. Что строим

Окно рядом с Roblox Studio на Windows 11. Ребёнок зажимает кнопку, говорит
по-русски «сделай лаву, которая убивает», отпускает. Робо отвечает голосом
простыми словами и через MCP строит это прямо в открытом месте Studio.
Родитель управляет промптом, правами и логом из скрытого режима, с того же
компьютера или со своего по локальной сети.

Принципы, продиктованные возрастом:

- голос в обе стороны, текст на экране одной строкой крупно;
- одна кнопка «зажал-говорю-отпустил», одна кнопка «Стоп»;
- четыре состояния с картинкой и звуком: слушаю, думаю, строю, говорю;
- результат ребёнок смотрит в Studio, а не в нашем окне;
- ответы Робо две-три фразы, одно действие, один вопрос максимум.

---

## 2. Ключевые решения и почему

| Вопрос | Решение | Основание |
|---|---|---|
| Движок | **Claude Agent SDK для TypeScript** поверх нативного `claude.exe` | SDK сам поднимает `claude` по stdio, даёт `canUseTool`, хуки, потоковый ввод, `includePartialMessages`, `resume`. У «сырого» CLI протокол разрешений (`control_request`) не документирован |
| Авторизация | Подписка Claude.ai через штатный `claude auth login` на машине ребёнка, вход выполняет родитель | Документация прямо допускает вход в немодифицированный бинарник Claude Code своей подпиской; `-p` и SDK списывают лимиты подписки. Это личный домашний инструмент, не продукт для других людей. Переключение на API-ключ это одна переменная окружения `ANTHROPIC_API_KEY` |
| Режим `--bare` | **Не использовать** | `--bare` не читает OAuth-учётку подписки, только API-ключ |
| Интерфейс | Страница в **Microsoft Edge в режиме `--app`**, не Electron | В Electron распознавание речи не работает в принципе (нет ключей Google, подтверждено issue 31732 и 46143). Edge даёт распознавание через Azure и нейронные русские голоса |
| Распознавание | Web Speech API в Edge (`ru-RU`), запасной путь локальный faster-whisper | Edge-распознавание на x64 работает, но исторически ломалось ошибкой `language-not-supported`. Нужен план Б без переписывания |
| Озвучка | Голоса Edge «Online (Natural)», запасной Piper `ru_RU-irina-medium` офлайн | Нейронные голоса требуют сети и имели регрессию в Edge 150. Библиотеки `edge-tts` без ключа не использовать: нарушают условия Microsoft |
| Кнопка | Экранная + глобальный хоткей через `uiohook-napi` | Поддерживается, N-API, Windows через `SetWindowsHookEx`. `iohook` и `node-global-key-listener` заброшены |
| Поверх окон | PowerShell `SetWindowPos(HWND_TOPMOST)` по заголовку окна | У Edge нет флага always-on-top |
| Roblox-аккаунт в Studio | Аккаунт **родителя** | Облачные сохранения и публикация без ограничений детского аккаунта, родитель открывает то же место у себя. Детский аккаунт Roblox Kids остаётся для игры |

---

## 3. Архитектура

```
┌────────────────────────────── Компьютер ребёнка (Windows 11 x64) ──────────────────────────────┐
│                                                                                                  │
│  Edge --app (localhost:3777)                 Node-сервер «robo-server»                           │
│  ┌──────────────────────────┐   WebSocket    ┌───────────────────────────────┐                   │
│  │ Кнопка, статусы, субтитры│◄─────────────►│ ws-хаб: события UI/агента      │                   │
│  │ Web Speech STT (ru-RU)   │                │ SpeechRouter: webspeech|whisper│                   │
│  │ speechSynthesis TTS      │                │ TtsRouter: edge|piper          │                   │
│  │ MediaRecorder (план Б)   │                │ Hotkey (uiohook-napi)          │                   │
│  │ /parent  (PIN)           │                │ Policy: allow/deny/ask         │                   │
│  └──────────────────────────┘                │ SessionStore (session_id)      │                   │
│                                              │ Agent SDK query()  ──────────┐ │                   │
│                                              └──────────────────────────────┼─┘                   │
│                                                                   stdio     │                     │
│                                              ┌──────────────────────────────▼─┐                   │
│                                              │ claude.exe (подписка, OAuth)   │                   │
│                                              │  mcpServers: Roblox_Studio     │                   │
│                                              └──────────────┬─────────────────┘                   │
│                                                   stdio     │  cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat
│                                              ┌──────────────▼─────────────────┐                   │
│                                              │ Roblox Studio (MCP-сервер вкл.)│                   │
│                                              │ открытое место, 27 инструментов│                   │
│                                              └────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ LAN, PIN
   Телефон или компьютер родителя: http://<ip-ребёнка>:3777/parent
```

### 3.1 Node-сервер (`robo-server`, TypeScript, Node 22)

Модули:

- **`agent/`**. Один долгоживущий `query()` с `prompt` в виде `AsyncIterable<SDKUserMessage>`. Опции:
  - `pathToClaudeCodeExecutable: %USERPROFILE%\.local\bin\claude.exe` (не `.cmd`-шим, на Windows они не работают из SDK и падают с `EINVAL` из `spawn`);
  - `env: { ...process.env }` (SDK заменяет окружение целиком, нужно спредить);
  - `cwd: C:\Robo\workspace`, `settingSources: []` (ни CLAUDE.md, ни чужих настроек);
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append: <prompt.md + project-notes.md> }`;
  - `mcpServers: { Roblox_Studio: { type: 'stdio', command: 'cmd.exe', args: ['/c', '<раскрытый путь>\\Roblox\\mcp.bat'] } }`, `strictMcpConfig: true`;
  - `permissionMode: 'default'`, `permissionPrompts: 'none'` не ставить, решения принимает `canUseTool`;
  - `tools: []` для встроенных инструментов (Bash, Edit, Write, WebFetch не нужны), `disallowedTools: ['Bash','Edit','Write','MultiEdit','NotebookEdit','WebFetch','WebSearch','Task']` на всякий случай;
  - `allowedTools`: список инструментов Roblox из раздела 4;
  - `includePartialMessages: true` для стриминга текста в озвучку;
  - `maxTurns: 40` на одну реплику ребёнка;
  - `model`: по умолчанию штатная модель; если задержка на детских запросах выше 10 с, переключить на `sonnet` через родительский режим;
  - `resume: <session_id>` при перезапуске, `session_id` берётся из события `system/init`.
- **`policy/`**. Реализация `canUseTool` плюс хук `PreToolUse` на `execute_luau` и `multi_edit` (раздел 4).
- **`speech/`**. Провайдеры распознавания: `webspeech` (всё в браузере, сервер только маршрутизирует) и `deepgram` (страница пишет MediaRecorder кусками по 250 мс и шлёт их бинарными кадрами WebSocket, сервер гонит их в поток Deepgram `wss://api.deepgram.com/v1/listen` и показывает промежуточный текст субтитром; по отпусканию кнопки `Finalize` + `CloseStream`; если поток сломался, та же запись уходит пакетным запросом). Озвучка: `edge` (speechSynthesis в браузере) и `elevenlabs` потоком: соединение `stream-input` открывается, когда ребёнок отпустил кнопку и Claude ещё думает; слова уходят по мере прихода `text_delta` через `StreamCleaner` (целые слова, без кода и путей), на конце предложения `flush`, MP3 приходит кусками и уходит на страницу событиями `audio.*`, страница играет через MediaSource. Один поток на текстовый блок ответа; служебные фразы («сейчас подумаю», «ещё строю») идут по старому пути `/api/tts` с кэшем и ждут, пока доиграет поток. Если поток упал, до конца реплики озвучка по предложениям. Запасные локальные провайдеры `whisper` и `piper` пока не реализованы.
- **`hotkey/`**. `uiohook-napi`: `keydown`/`keyup` выбранной клавиши превращаются в события `ptt.down`/`ptt.up` в WebSocket. Клавиша задаётся в конфиге, по умолчанию `F8`.
- **`ws/`**. Один канал. События от UI: `ptt.down`, `ptt.up`, `utterance` (текст), `stop`, `parent.*`. События к UI: `state` (listen/think/build/speak/idle), `caption`, `speak` (фраза для озвучки), `tool` (имя инструмента для анимации «строю»), `error`.
- **`parent/`**. Страница `/parent` с PIN. Лог диалога, редактор `prompt.md`, переключатели политики, кнопка «новая игра» (сброс сессии), выбор провайдеров речи, таймер сессии, текстовый ввод в текущую сессию (родитель подсказывает с телефона). Сервер слушает `0.0.0.0`, доступ только с PIN и только из локальной сети.
- **`launcher/`**. PowerShell-скрипт: `git pull`, `npm ci` при изменении lock-файла, старт сервера скрыто, запуск Edge, через две секунды `SetWindowPos` на окно с заголовком «Робо». Ярлык на рабочем столе ведёт на `powershell.exe -WindowStyle Hidden -File launch.ps1`.

### 3.2 Страница (`robo-ui`, чистый HTML + TypeScript, без фреймворка)

- Один экран: большая круглая кнопка, индикатор состояния, строка субтитров, кнопка «Стоп», в углу невидимая зона долгого нажатия для родительского режима.
- STT: `new (window.SpeechRecognition || window.webkitSpeechRecognition)()`, `lang = 'ru-RU'`, `continuous = false`, `interimResults = true`, `maxAlternatives = 3`. `start()` на `ptt.down`, `stop()` на `ptt.up`. Если результат короче двух слов или пришёл `no-speech`, озвучить «Я не расслышал, скажи ещё раз». Ошибку `language-not-supported` или `network` ловим и автоматически переключаемся на провайдер `whisper`, в родительский лог пишем предупреждение.
- TTS: дождаться `voiceschanged`, выбрать голос по регулярному выражению `/Online \(Natural\).*Russian/` с фильтром записей, где `name` или `lang` равны `undefined` (регрессия Edge 150). Если такого голоса нет, провайдер `piper`. Озвучивать по предложениям по мере прихода `text_delta`, не ждать конца ответа. Новое `ptt.down` или «Стоп» вызывает `speechSynthesis.cancel()` и `query.interrupt()`.
- Очистка текста перед озвучкой: убрать блоки кода, маркдаун, имена инструментов, пути вида `game.Workspace.X` заменять на «объект».
- Микрофон: Edge запускается с отдельным `--user-data-dir`, разрешение на микрофон для `http://localhost` даётся один раз и сохраняется в профиле. `localhost` считается безопасным источником, HTTPS не нужен.

### 3.3 Запуск Edge

```
msedge.exe --app=http://localhost:3777/
  --user-data-dir=%LOCALAPPDATA%\Robo\edge-profile
  --window-size=420,900 --window-position=1480,40
  --no-first-run --autoplay-policy=no-user-gesture-required
```

Размер и позиция применяются при первом запуске профиля, дальше Edge помнит их сам. `--kiosk` не подходит: полноэкранный, Studio не видно. Профиль обязателен: иначе флаги игнорируются, если у ребёнка уже открыт обычный Edge.

### 3.4 Claude Code на машине ребёнка

- Установка: `irm https://claude.ai/install.ps1 | iex` под учётной записью ребёнка в Windows. Бинарник ляжет в `%USERPROFILE%\.local\bin\claude.exe`, автообновление включено.
- Git for Windows ставить необязательно, Bash-инструмент мы отключаем.
- Вход: `claude auth login`. Ссылку открываете на своём компьютере, код вставляете в терминал ребёнка. Учётка сохраняется в `%USERPROFILE%\.claude\.credentials.json` с правами только этого пользователя Windows. Браузер ребёнка в Claude.ai не входит.
- Проверка: `claude auth status` должен показать `authMethod: claude.ai`.
- Roblox Studio: Assistant → «…» → Manage MCP Servers → включить «Enable Studio as MCP server». Quick connect не нужен, мы передаём конфиг сервера сами через `mcpServers` и `strictMcpConfig`.

---

## 4. Политика прав: что Робо может делать в Studio

Встроенный MCP-сервер Studio даёт 27 инструментов, все с параметром `studio_id`. Имена в Claude Code получают префикс `mcp__Roblox_Studio__`.

**Разрешено всегда** (чтение и безопасные действия):
`list_roblox_studios`, `get_studio_state`, `search_game_tree`, `inspect_instance`, `script_read`, `script_search`, `script_grep`, `get_console_output`, `screen_capture`, `http_get`, `skill`, `subagent`, `wait_job_finished`, `start_stop_play`, `character_navigation`, `user_keyboard_input`, `user_mouse_input`.

**Разрешено с проверкой кода** (через хук `PreToolUse`, см. ниже):
`execute_luau`, `multi_edit`.

**Разрешено, родитель может переключить в «спрашивать»**:
`generate_mesh`, `generate_material`, `generate_procedural_model` (у Studio лимит 50 процедурных моделей в сутки), `insert_asset`, `search_asset` (в `canUseTool` принудительно добавлять фильтр «бесплатные», если инструмент его принимает), `store_image`.

**Запрещено по умолчанию**:
`upload_image` (загружает картинки в аккаунт Roblox), все встроенные инструменты Claude Code.

**Хук на Luau.** Список разрешённых инструментов не ограничивает, что делает код внутри `execute_luau`. Поэтому `PreToolUse` с матчером `mcp__Roblox_Studio__execute_luau|mcp__Roblox_Studio__multi_edit` проверяет `tool_input` на подстроки `DataStoreService`, `HttpService`, `MarketplaceService`, `TeleportService`, `PublishService`, `MessagingService`, `game:GetService("Players"):Kick`, `Destroy()` на `game.Workspace` целиком и возвращает `permissionDecision: "deny"` с понятной причиной. Причина попадает Claude как результат инструмента, он объясняет ребёнку по-другому.

**Удаление.** Отдельный флаг «спрашивать перед удалением» в родительском режиме: если `execute_luau` содержит `:Destroy()` или `multi_edit` удаляет строки, `canUseTool` отправляет запрос в родительский канал и ждёт ответ до 60 секунд, ребёнку озвучивается «спроси маму или папу». По умолчанию флаг выключен, Робо сам переспрашивает ребёнка голосом по промпту.

Порядок оценки в SDK: хуки → deny-правила → ask → режим → allow → `canUseTool`. Инструменты из `allowedTools` до `canUseTool` не доходят, поэтому «условные» инструменты в `allowedTools` не включать.

---

## 5. Системный промпт (`prompt.md`, редактируется родителем)

Черновик, который предстоит обкатать на реальных фразах:

- Ты Робо, помощник семилетнего ребёнка, который строит игру в Roblox Studio. Говори по-русски.
- Короткие фразы, простые слова, одна мысль в предложении. Ответ не длиннее трёх предложений. Термины не используй, а если без них никак, объясни одним простым сравнением.
- Сначала делай, потом говори, что сделал, одним предложением. Код не показывай и не называй имена скриптов и сервисов, пока ребёнок не скажет «покажи код».
- Если непонятно, что хочет ребёнок, задай один вопрос с двумя вариантами на выбор.
- Перед тем как удалить или сильно изменить то, что уже построено, переспроси.
- Хвали за идею коротко, предлагай один следующий шаг, не план.
- Имена объектов ребёнок говорит приблизительно. Сам найди подходящий объект через поиск по дереву, не требуй точных названий.
- В начале работы вызови `list_roblox_studios`. Если Studio не подключена, скажи «открой свою игру в Roblox Studio и нажми кнопку ещё раз».
- Никогда не публикуй игру, не сохраняй в облако, не используй DataStore, HTTP, покупки и телепорты. Если ребёнок просит «выложить игру», скажи, что это делает мама или папа.
- Постройки для семилетки: лава, платформы, прыжки, чекпоинты, монетки, двери, кнопки, цвета, звуки. Не предлагай сложное.

`project-notes.md` рядом: краткое описание, что уже построено. Робо обновляет его через инструмент заметок (единственный разрешённый встроенный инструмент: `Write` с правилом `Write(C:\Robo\workspace\project-notes.md)`), сервер подмешивает файл в `append` при старте новой сессии. Так новая сессия после сброса знает контекст.

---

## 6. Диалоговый цикл

1. `ptt.down` → состояние «слушаю», звук «бип», STT старт, `speechSynthesis.cancel()`.
2. `ptt.up` → STT стоп, ждём `result`. Пусто или `no-speech` → озвучить переспрос, в idle.
3. Текст → `SDKUserMessage` в поток `query()`, состояние «думаю», таймер 4 секунды: если не пришло ни одного `text_delta`, озвучить «сейчас подумаю».
4. Первый `tool_use` → состояние «строю», анимация, каждые 15 секунд без событий озвучивать короткое «ещё строю».
5. `text_delta` → копим до конца предложения → `speak` в UI → состояние «говорю». Субтитр показывает только текущее предложение.
6. `result` → состояние idle, кнопка снова активна. Кнопка заблокирована с шага 3 до шага 6, повторный `ptt.down` во время «строю» прерывает через `query.interrupt()` и озвучивает «остановился».
7. `rate_limit_event` с `credits_required` или ошибка `authentication_failed` → озвучить «мне нужен отдых, позови родителей», в родительский лог полная причина.

---

## 7. Структура репозитория

```
robo/
  package.json              workspaces: server, ui
  server/
    src/index.ts            старт http+ws, загрузка config
    src/agent/session.ts    query(), поток сообщений, resume
    src/agent/events.ts     разбор SDKMessage → события UI
    src/policy/rules.ts     allowedTools, disallowedTools
    src/policy/canUseTool.ts
    src/policy/luauGuard.ts hook PreToolUse
    src/speech/{stt,tts}/   провайдеры
    src/hotkey.ts
    src/parent/             маршруты /parent, PIN
    src/config.ts           config.json + prompt.md + project-notes.md
  ui/
    index.html, app.ts, stt.ts, tts.ts, ws.ts, parent.html
    assets/ звуки, картинки состояний
  scripts/
    install.ps1             установка на машине ребёнка
    launch.ps1              запуск скрыто, Edge, SetWindowPos
    make-shortcut.ps1
    topmost.ps1
  config/
    config.example.json     порт, клавиша, провайдеры, PIN-хэш, пути
    prompt.md
  workspace/                cwd для claude, project-notes.md (в .gitignore)
  tests/
    phrases.ru.json         детские фразы для прогона
```

Код обёртки живёт в git. На машине ребёнка `launch.ps1` делает `git pull` перед стартом. `prompt.md` и `config.json` не в git, лежат в `%LOCALAPPDATA%\Robo\`, чтобы правки родителя из панели не конфликтовали с репозиторием.

---

## 8. Риски и что с ними делать

| Риск | Вероятность | План |
|---|---|---|
| Edge STT отдаёт `language-not-supported` после обновления Edge | средняя | Автопереключение на whisper |
| Детский голос распознаётся плохо | средняя | Гарнитура, `maxAlternatives=3`, промпт «догадывайся по смыслу», при необходимости whisper `medium` |
| Задержка от реплики до первого слова больше 6 с | средняя | Озвучка по предложениям, «сейчас подумаю», модель `sonnet`, меньше инструментов в контексте |
| Claude Code автообновился и изменил поведение `-p` | низкая | `DISABLE_AUTOUPDATER=1` на машине ребёнка, обновлять руками раз в месяц после прогона тестов |
| Исчерпан лимит подписки в вечер, когда он нужен вам | средняя | Таймер сессии в родительском режиме, уведомление в лог при `rate_limit_event`; переход на API-ключ одной переменной |
| Luau-код делает что-то нежелательное | низкая | Хук из раздела 4, Studio под аккаунтом родителя, `upload_image` запрещён, публикация только руками |
| Studio не подключена, ребёнок жмёт кнопку | высокая | Промпт велит сказать «открой игру», сервер проверяет `mcp_servers.status` в `system/init` и озвучивает подсказку сам |
| Регрессия голосов в Edge | низкая | Фильтр `undefined`, Piper в запасе |

---

## 9. Что остаётся вне кода

- **Условия использования.** Claude.ai требует 18+, аккаунт ваш, вход выполняете вы, инструмент под вашим присмотром. Документация Anthropic разрешает вход своей подпиской в немодифицированный Claude Code и запрещает предлагать такой вход другим пользователям. Поэтому Робо не выкладывать как продукт с подпиской; для чужих пользователей только API-ключ.
- **Roblox.** Studio под вашим аккаунтом Roblox. Для ребёнка 5–8 лет аккаунт Roblox Kids с привязкой к родителю, он для игры. Приглашение друзей-тестеров до 9 лет недоступно, публикацию и доступ для друзей делаете вы с Creator Dashboard. Для совместной работы с разных аккаунтов нужна проверка возраста, проще открывать то же место под вашим аккаунтом на своём ПК.
- **Studio всё равно взрослый инструмент.** Play, сохранение, выделение объектов это взрослый рядом. Робо снимает программирование, не Studio.

---

## 10. Источники

Claude Code: https://code.claude.com/docs/en/cli-reference , /headless , /agent-sdk/typescript , /agent-sdk/permissions , /agent-sdk/streaming-vs-single-mode , /agent-sdk/hosting , /agent-sdk/troubleshooting , /permissions , /permission-modes , /settings , /mcp , /hooks , /setup , /authentication , /legal-and-compliance ; https://support.claude.com/en/articles/15036540

Roblox: https://create.roblox.com/docs/studio/mcp , /docs/assistant/guide , /docs/studio/setup , /docs/projects/collaboration , /docs/production/publishing/publish-games-and-places , /docs/production/publishing/kids-and-select ; https://github.com/Roblox/studio-rust-mcp-server (архив)

Речь и Windows: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies#speechrecognitionenabled , https://github.com/mdn/browser-compat-data/issues/22126 , https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api , https://github.com/electron/electron/issues/31732 , https://github.com/electron/electron/issues/46143 , https://github.com/phetsims/utterance-queue/issues/60 , https://github.com/SnosMe/uiohook-napi , https://github.com/SYSTRAN/faster-whisper , https://github.com/rhasspy/piper/blob/master/VOICES.md , https://github.com/nodejs/node/issues/52681 , https://textslashplain.com/2022/01/05/edge-command-line-arguments
