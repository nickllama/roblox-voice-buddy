# Robo: architecture

Architecture and the reasoning behind the decisions. Compiled from the official
documentation of Claude Code and the Agent SDK (code.claude.com), Roblox Studio MCP
(create.roblox.com), Microsoft Edge and the Web Speech API. Points that the
documentation does not confirm are marked "verify on the machine".


---

## 1. What we are building

A window next to Roblox Studio on Windows 11. The child holds a button, says
«сделай лаву, которая убивает» ("make lava that kills"), and releases. Robo answers
out loud in simple words and, through MCP, builds it right in the open Studio place.
The parent manages the prompt, permissions and the log from a hidden mode, on the
same computer or from their own over the local network.

Principles dictated by the child's age:

- voice in both directions, text on screen as one large line;
- one "hold to talk, release to send" button, one "Stop" button;
- four states with a picture and a sound: listening, thinking, building, speaking;
- the child watches the result in Studio, not in our window;
- Robo's answers are two or three sentences, one action, at most one question.

---

## 2. Key decisions and why

| Question | Decision | Reasoning |
|---|---|---|
| Engine | **Claude Agent SDK for TypeScript** on top of the native `claude.exe` | The SDK starts `claude` over stdio itself and provides `canUseTool`, hooks, streaming input, `includePartialMessages`, `resume`. The permission protocol of the "raw" CLI (`control_request`) is undocumented |
| Authorization | Claude.ai subscription through the standard `claude auth login` on the child's machine, the parent signs in | The documentation explicitly allows signing in to an unmodified Claude Code binary with your own subscription; `-p` and the SDK consume the subscription limits. This is a personal home tool, not a product for other people. Switching to an API key is one environment variable, `ANTHROPIC_API_KEY` |
| `--bare` mode | **Do not use** | `--bare` does not read the subscription OAuth account, only an API key |
| Interface | A page in **Microsoft Edge in `--app` mode**, not Electron | Speech recognition does not work in Electron at all (no Google keys, confirmed by issues 31732 and 46143). Edge provides recognition through Azure and neural voices in many languages, Russian included |
| Speech recognition | Web Speech API in Edge (language from `config.language`), fallback local faster-whisper | Edge recognition works on x64 but has historically broken with the `language-not-supported` error. A plan B without a rewrite is needed |
| TTS | Edge "Online (Natural)" voices for the configured language, fallback Piper offline (for example `ru_RU-irina-medium`) | Neural voices need the network and had a regression in Edge 150. Do not use `edge-tts` libraries without a key: they violate Microsoft's terms |
| Button | On-screen plus a global hotkey through `uiohook-napi` | Maintained, N-API, Windows through `SetWindowsHookEx`. `iohook` and `node-global-key-listener` are abandoned |
| Always on top | PowerShell `SetWindowPos(HWND_TOPMOST)` by window title | Edge has no always-on-top flag |
| Roblox account in Studio | The **parent's** account | Cloud saves and publishing without the restrictions of a child account; the parent opens the same place on their own machine. The child's Roblox Kids account stays for playing |

---

## 3. Architecture

```
┌─────────────────────────────── Child's computer (Windows 11 x64) ────────────────────────────────┐
│                                                                                                  │
│  Edge --app (localhost:3777)                  Node server "robo-server"                          │
│  ┌──────────────────────────────┐  WebSocket  ┌──────────────────────────────────┐               │
│  │ Button, states, captions     │◄───────────►│ ws hub: UI/agent events          │               │
│  │ Web Speech STT (config lang) │             │ SpeechRouter: webspeech|deepgram │               │
│  │ speechSynthesis TTS          │             │ TtsRouter: edge|elevenlabs|fish  │               │
│  │ MediaRecorder (plan B)       │             │ Hotkey (uiohook-napi)            │               │
│  │ /parent  (PIN)               │             │ Policy: allow/deny/ask           │               │
│  └──────────────────────────────┘             │ SessionStore (session_id)        │               │
│                                               │ Agent SDK query()  ────────────┐ │               │
│                                               └────────────────────────────────┼─┘               │
│                                                                    stdio       │                 │
│                                               ┌────────────────────────────────▼─┐               │
│                                               │ claude.exe (subscription, OAuth) │               │
│                                               │  mcpServers: Roblox_Studio       │               │
│                                               └──────────────┬───────────────────┘               │
│                                                    stdio     │  cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat
│                                               ┌──────────────▼───────────────────┐               │
│                                               │ Roblox Studio (MCP server on)    │               │
│                                               │ open place, 27 tools             │               │
│                                               └──────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ LAN, PIN
   Parent's phone or computer: http://<child-pc-ip>:3777/parent
```

### 3.1 Node server (`robo-server`, TypeScript, Node 22)

Modules:

- **`agent/`**. One long-lived `query()` with `prompt` as an `AsyncIterable<SDKUserMessage>`. Options:
  - `pathToClaudeCodeExecutable: %USERPROFILE%\.local\bin\claude.exe` (not the `.cmd` shim: on Windows shims do not work from the SDK and fail with `EINVAL` from `spawn`);
  - `env: { ...process.env }` (the SDK replaces the environment entirely, it has to be spread in);
  - `cwd: C:\Robo\workspace`, `settingSources: []` (no CLAUDE.md, no foreign settings);
  - `systemPrompt`: Robo's own prompt as a string, built by `buildSystemPrompt()` in `agent/session.ts`: the language rule first (`config.language`, every word is read aloud), then prompt.local.md if present, otherwise prompt.md, then the server-owned working rules (playtest only on request unless `policy.playtest` is on; how to keep project-notes.md), then project-notes.md. Not the `claude_code` preset: that preset is a long English coding-agent prompt that pushed the language rule and the three-sentence limit to the tail, where Claude lost them after long tool runs, and its "verify your work" habit made Robo playtest for a minute after every change;
  - `mcpServers: { Roblox_Studio: { type: 'stdio', command: 'cmd.exe', args: ['/c', '<expanded path>\\Roblox\\mcp.bat'] } }`, `strictMcpConfig: true`;
  - `permissionMode: 'default'`; do not set `permissionPrompts: 'none'`, decisions are made by `canUseTool`;
  - `tools: []` for built-in tools (Bash, Edit, Write, WebFetch are not needed), `disallowedTools: ['Bash','Edit','Write','MultiEdit','NotebookEdit','WebFetch','WebSearch','Task']` just in case;
  - `allowedTools`: the list of Roblox tools from section 4;
  - `includePartialMessages: true` to stream text into TTS;
  - `maxTurns: 40` per child utterance;
  - `model`: the default model; if latency on the child's requests exceeds 10 s, switch to `sonnet` from parent mode;
  - `resume: <session_id>` on restart; `session_id` is taken from the `system/init` event.
- **`policy/`**. The `canUseTool` implementation plus a `PreToolUse` hook on `execute_luau` and `multi_edit` (section 4).
- **`speech/`**. Speech recognition providers: `webspeech` (everything in the browser, the server only routes) and `deepgram` (the page records MediaRecorder chunks of 250 ms and sends them as binary WebSocket frames; the server feeds them into a Deepgram stream at `wss://api.deepgram.com/v1/listen` and shows the interim text as a caption; on button release `Finalize` + `CloseStream`; if the stream breaks, the same recording is sent as a batch request). TTS: `edge` (speechSynthesis in the browser), `elevenlabs` and `fish` (Fish Audio, `s2.1-pro-free` is free; its `tts/live` WebSocket speaks MessagePack with `start`/`text`/`flush`/`stop` events) streamed: a connection is opened when the child has released the button and Claude is still thinking; words are sent as `text_delta` arrives, through `StreamCleaner` (whole words, no code or paths); `flush` at the end of a sentence; MP3 arrives in chunks and goes to the page as `audio.*` events, which the page plays through MediaSource. One stream per text block of the reply; system phrases ("let me think", "still building") go through the old `/api/tts` path with a cache and wait for the stream to finish playing. If the stream fails, the rest of the reply is spoken sentence by sentence. The local fallback providers `whisper` and `piper` are not implemented yet.
- **`i18n`**. `config.language` (BCP-47, default `en-US` in `config.example.json`) drives three things: the language of speech recognition and TTS, the set of child-facing phrases (on-screen statuses and spoken system phrases in `server/src/i18n.ts` and `ui/i18n.js`, `en` and `ru` shipped, fallback `en`), and the line appended to the system prompt. `config/prompt.md` is English; the parent edits `config/prompt.local.md` (untracked) in any language. Sample child utterances for prompt runs: `tests/phrases.en.json`, `tests/phrases.ru.json`.
- **`hotkey/`**. `uiohook-napi`: `keydown`/`keyup` of the chosen key become `ptt.down`/`ptt.up` events in the WebSocket. The key is set in the config, default `F8`.
- **`ws/`**. One channel. Events from the UI: `ptt.down`, `ptt.up`, `utterance` (text), `stop`, `parent.*`. Events to the UI: `state` (listen/think/build/speak/idle), `caption`, `speak` (phrase to voice), `tool` (tool name for the "building" animation), `error`.
- **`parent/`**. The `/parent` page with a PIN. Dialogue log, prompt editor, policy toggles, a "new game" button (session reset), speech provider selection, the "allow publishing?" question (Robo's own in-process MCP tool `request_publish` in `agent/roboTools.ts`: Claude calls it after the child asks to publish and the game is checked; the tool asks the parent through the gate and runs `scripts/publish.ps1` only on a yes, so publishing is in the allowlist by name but decided by a person), play timer (`session.maxMinutes` from the child's first command, then `session.breakMinutes` of break with a countdown on the child's page; the Claude session stays alive, so the game is kept; "Break now" / "Continue now" in the panel), text input into the current session (the parent gives hints from a phone). The server listens on `0.0.0.0`; access only with the PIN and only from the local network.
- **`launcher/`**. PowerShell script: `git pull`, `npm ci` when the lock file changed, start the server hidden, launch Edge, two seconds later `SetWindowPos` on the window titled "Robo". The desktop shortcut points to `powershell.exe -WindowStyle Hidden -File launch.ps1`.

### 3.2 Page (`robo-ui`, plain HTML + TypeScript, no framework)

- One screen: a big round button, a state indicator, a caption line, a "Stop" button, and an invisible long-press zone in the corner for parent mode.
- STT: `new (window.SpeechRecognition || window.webkitSpeechRecognition)()`, `lang = config.language`, `continuous = false`, `interimResults = true`, `maxAlternatives = 3`. `start()` on `ptt.down`, `stop()` on `ptt.up`. If the result is shorter than two words or `no-speech` arrives, speak "I didn't catch that. Say it again." (from `i18n`). Catch the `language-not-supported` or `network` error and switch automatically to the `deepgram` provider when a key is configured, writing a warning to the parent log.
- TTS: wait for `voiceschanged`, pick a voice by the regular expression `tts.edge.voiceMatch` (default `Online \(Natural\)`) among the voices whose `lang` matches `config.language`, filtering out entries where `name` or `lang` is `undefined` (Edge 150 regression). If there is no such voice, use the `piper` provider. Speak sentence by sentence as `text_delta` arrives, do not wait for the end of the reply. A new `ptt.down` or "Stop" calls `speechSynthesis.cancel()` and `query.interrupt()`.
- Text cleanup before speaking: strip code blocks, markdown and tool names; replace paths like `game.Workspace.X` with "the object".
- Microphone: Edge starts with its own `--user-data-dir`; the microphone permission for `http://localhost` is granted once and stored in the profile. `localhost` counts as a secure origin, HTTPS is not needed.

### 3.3 Launching Edge

```
msedge.exe --app=http://localhost:3777/
  --user-data-dir=%LOCALAPPDATA%\Robo\edge-profile
  --window-size=420,900 --window-position=1480,40
  --no-first-run --autoplay-policy=no-user-gesture-required
```

Size and position apply on the profile's first launch; after that Edge remembers them itself. `--kiosk` does not fit: full screen, Studio is not visible. The profile is mandatory: otherwise the flags are ignored if the child already has a regular Edge window open.

### 3.4 Claude Code on the child's machine

- Install: `irm https://claude.ai/install.ps1 | iex` under the child's Windows account. The binary lands in `%USERPROFILE%\.local\bin\claude.exe`, auto-update is on.
- Git for Windows is optional, we disable the Bash tool.
- Sign in: `claude auth login`. Open the link on your own computer, paste the code into the child's terminal. The account is stored in `%USERPROFILE%\.claude\.credentials.json` with permissions for this Windows user only. The child's browser is not signed in to Claude.ai.
- Check: `claude auth status` must show `authMethod: claude.ai`.
- Roblox Studio: Assistant → "…" → Manage MCP Servers → enable "Enable Studio as MCP server". Quick connect is not needed, we pass the server config ourselves through `mcpServers` and `strictMcpConfig`.

---

## 4. Permission policy: what Robo may do in Studio

The built-in Studio MCP server provides 27 tools, all with a `studio_id` parameter. In Claude Code their names get the prefix `mcp__Roblox_Studio__`.

**Always allowed** (reading and safe actions):
`list_roblox_studios`, `get_studio_state`, `search_game_tree`, `inspect_instance`, `script_read`, `script_search`, `script_grep`, `get_console_output`, `screen_capture`, `http_get`, `skill`, `subagent`, `wait_job_finished`, `start_stop_play`, `character_navigation`, `user_keyboard_input`, `user_mouse_input`.

**Allowed with a code check** (through the `PreToolUse` hook, see below):
`execute_luau`, `multi_edit`.

**Allowed, the parent can switch to "ask"**:
`generate_mesh`, `generate_material`, `generate_procedural_model` (Studio limits procedural models to 50 per day), `insert_asset`, `search_asset` (in `canUseTool`, force the "free" filter if the tool accepts it), `store_image`.

**Denied by default**:
`upload_image` (uploads images to the Roblox account), all built-in Claude Code tools.

**The Luau hook.** The allowed tool list does not limit what the code inside `execute_luau` does. So a `PreToolUse` hook with the matcher `mcp__Roblox_Studio__execute_luau|mcp__Roblox_Studio__multi_edit` checks `tool_input` for the substrings `DataStoreService`, `HttpService`, `MarketplaceService`, `TeleportService`, `PublishService`, `MessagingService`, `game:GetService("Players"):Kick`, `Destroy()` on `game.Workspace` as a whole, and returns `permissionDecision: "deny"` with a clear reason. The reason reaches Claude as the tool result, and it explains to the child in other words.

**Deletion.** A separate "ask before deleting" flag in parent mode: if `execute_luau` contains `:Destroy()` or `multi_edit` deletes lines, `canUseTool` sends a request to the parent channel and waits up to 60 seconds for an answer; the child hears "Ask a grown-up if that's okay.". The flag is off by default; Robo itself double-checks with the child by voice, as the prompt instructs.

Evaluation order in the SDK: hooks → deny rules → ask → mode → allow → `canUseTool`. Tools listed in `allowedTools` never reach `canUseTool`, so do not put "conditional" tools into `allowedTools`.

---

## 5. System prompt (`config/prompt.md`, parent edits go to `config/prompt.local.md`)

A draft still to be tried on real phrases. The real file is `config/prompt.md`, in English; the server appends the child's language from `config.language`:

- You are Robo, a helper for a seven-year-old child who is building a game in Roblox Studio. Speak the child's language.
- Short sentences, simple words, one idea per sentence. No more than three sentences per answer. Avoid technical terms; if one is unavoidable, explain it with one simple comparison.
- Do first, then say what you did in one sentence. Do not show code and do not name scripts or services until the child says "show me the code".
- If it is unclear what the child wants, ask one question with two options to choose from.
- Before deleting or heavily changing something already built, ask again.
- Praise the idea briefly, suggest one next step, not a plan.
- The child names objects approximately. Find the matching object yourself by searching the tree; do not demand exact names.
- At the start of work call `list_roblox_studios`. If Studio is not connected, say "open your game in Roblox Studio and press the button again".
- Never publish the game, save to the cloud, or use DataStore, HTTP, purchases or teleports. If the child asks to "publish the game", say that mom or dad does that.
- Builds for a seven-year-old: lava, platforms, jumps, checkpoints, coins, doors, buttons, colors, sounds. Do not suggest anything complicated.

`project-notes.md` next to it: a short description of what has already been built. Robo updates it through the notes tool (the only allowed built-in tool: `Write` with the rule `Write(C:\Robo\workspace\project-notes.md)`), and the server mixes the file into `append` when a new session starts. This way a new session after a reset knows the context.

---

## 6. Dialogue loop

1. `ptt.down` → state "listening", "beep" sound, STT start, `speechSynthesis.cancel()`.
2. `ptt.up` → STT stop, wait for `result`. Empty or `no-speech` → speak the "say it again" phrase, go idle.
3. Text → `SDKUserMessage` into the `query()` stream, state "thinking", 4-second timer: if no `text_delta` has arrived, speak "let me think".
4. First `tool_use` → state "building", animation; every 15 seconds without events speak a short "still building".
5. `text_delta` → accumulate until the end of a sentence → `speak` to the UI → state "speaking". The caption shows only the current sentence.
6. `result` → state idle, the button is active again. The button is locked from step 3 to step 6; a repeated `ptt.down` during "building" interrupts through `query.interrupt()` and cancels the current speech.
7. `rate_limit_event` with `credits_required` or an `authentication_failed` error → speak "I need a rest. Call a grown-up."; the full reason goes to the parent log.

---

## 7. Repository structure

```
robo/
  package.json              workspaces: server, ui
  server/
    src/index.ts            start http+ws, load config
    src/agent/session.ts    query(), message stream, resume
    src/agent/events.ts     SDKMessage parsing → UI events
    src/policy/rules.ts     allowedTools, disallowedTools
    src/policy/canUseTool.ts
    src/policy/luauGuard.ts PreToolUse hook
    src/speech/{stt,tts}/   providers
    src/i18n.ts             child-facing phrases (en, ru)
    src/hotkey.ts
    src/parent/             /parent routes, PIN
    src/config.ts           config.json, prompt.md or prompt.local.md, project-notes.md
  ui/
    index.html, app.ts, stt.ts, tts.ts, ws.ts, i18n.js, parent.html
    assets/ sounds, state pictures
  scripts/
    bootstrap.ps1           one-line installer (irm | iex): Git, Node, clone, install, settings, sign-in, launch
    publish.ps1             "Publish" button of the parent panel: Alt+P into the Studio window (a parent's action, not Claude's)
    install.ps1             installation on the child's machine
    launch.ps1              hidden start, Edge, SetWindowPos
    make-shortcut.ps1
    topmost.ps1
  config/
    config.example.json     port, key, language, providers, PIN hash, paths
    prompt.md               system prompt (English)
  workspace/                cwd for claude, project-notes.md (in .gitignore)
  tests/
    phrases.en.json         sample child phrases for prompt runs
    phrases.ru.json
```

The wrapper code lives in git. On the child's machine `launch.ps1` does `git pull` before starting. `config.json` and `prompt.local.md` are not in git (untracked files in `config/`), so the parent's edits from the panel do not conflict with the repository.

---

## 8. Risks and what to do about them

| Risk | Likelihood | Plan |
|---|---|---|
| Edge STT returns `language-not-supported` after an Edge update | medium | Automatic switch to Deepgram (local whisper planned) |
| The child's voice is recognized poorly | medium | Headset, `maxAlternatives=3`, a "guess from the meaning" prompt, whisper `medium` if needed |
| Latency from utterance to first word above 6 s | medium | Sentence-by-sentence TTS, "let me think", the `sonnet` model, fewer tools in context |
| Claude Code auto-updated and changed the `-p` behavior | low | `DISABLE_AUTOUPDATER=1` on the child's machine, update by hand once a month after running the tests |
| Subscription limit exhausted in the evening when you need it yourself | medium | Session timer in parent mode, log notification on `rate_limit_event`; switch to an API key with one variable |
| Luau code does something unwanted | low | The hook from section 4, Studio under the parent's account, `upload_image` denied, publishing only by hand |
| Studio is not connected and the child presses the button | high | The prompt tells Robo to say "open the game"; the server checks `mcp_servers.status` in `system/init` and speaks the hint itself |
| Voice regression in Edge | low | The `undefined` filter, Piper as a fallback |

---

## 9. What stays outside the code

- **Terms of use.** Claude.ai requires 18+; the account is yours, you sign in, the tool is used under your supervision. Anthropic's documentation allows signing in with your own subscription to an unmodified Claude Code and forbids offering such sign-in to other users. So Robo must not be shipped as a subscription-based product; for other users, API key only.
- **Roblox.** Studio under your Roblox account. For a child aged 5 to 8, a Roblox Kids account linked to the parent, for playing. Inviting friend testers under 9 is unavailable; publishing and friend access are done by you from the Creator Dashboard. Collaboration from different accounts requires age verification; it is easier to open the same place under your account on your own PC.
- **Studio is still an adult tool.** Play, saving, selecting objects mean an adult nearby. Robo removes the programming, not Studio.

---

## 10. Sources

Claude Code: https://code.claude.com/docs/en/cli-reference , /headless , /agent-sdk/typescript , /agent-sdk/permissions , /agent-sdk/streaming-vs-single-mode , /agent-sdk/hosting , /agent-sdk/troubleshooting , /permissions , /permission-modes , /settings , /mcp , /hooks , /setup , /authentication , /legal-and-compliance ; https://support.claude.com/en/articles/15036540

Roblox: https://create.roblox.com/docs/studio/mcp , /docs/assistant/guide , /docs/studio/setup , /docs/projects/collaboration , /docs/production/publishing/publish-games-and-places , /docs/production/publishing/kids-and-select ; https://github.com/Roblox/studio-rust-mcp-server (archived)

Speech and Windows: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies#speechrecognitionenabled , https://github.com/mdn/browser-compat-data/issues/22126 , https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api , https://github.com/electron/electron/issues/31732 , https://github.com/electron/electron/issues/46143 , https://github.com/phetsims/utterance-queue/issues/60 , https://github.com/SnosMe/uiohook-napi , https://github.com/SYSTRAN/faster-whisper , https://github.com/rhasspy/piper/blob/master/VOICES.md , https://github.com/nodejs/node/issues/52681 , https://textslashplain.com/2022/01/05/edge-command-line-arguments
