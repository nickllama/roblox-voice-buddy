# Robo

**Voice buddy for kids building games in Roblox Studio.** A child holds a button
and speaks, Robo answers out loud in simple words and builds the thing right
inside the open Roblox Studio place.

Under the hood: a local Node process + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
driving `claude` + the built-in [Roblox Studio MCP server](https://create.roblox.com/docs/studio/mcp)
+ a Microsoft Edge app-mode page for speech recognition and neural TTS. Windows 11 x64.
A tool allowlist and a Luau guard keep the agent away from DataStores, HTTP, purchases
and publishing; a PIN-protected parent panel shows the log, edits the prompt and
approves risky actions. Architecture and the reasoning behind it: [docs/plan.md](docs/plan.md).
MIT licensed.

## Install on the child's PC

One line in PowerShell under the child's Windows account:

```powershell
irm https://raw.githubusercontent.com/nickllama/roblox-voice-buddy/main/scripts/bootstrap.ps1 | iex
```

It installs Git and Node.js if they are missing (winget), clones the repository into `C:\Robo`
(or `$env:ROBO_DIR`), installs Claude Code and dependencies, asks for the child's language and
the parent PIN, runs `claude auth login` (open the link on your own PC, paste the code), and
starts Robo. Running it again updates instead of reinstalling.

Two things stay manual: the Claude sign-in code, and once inside Roblox Studio:
**Assistant → … → Manage MCP Servers → Enable Studio as MCP server**.

The "Robo" desktop shortcut starts everything afterwards: update from git, the server, the Edge window.
On every page load Robo checks the browser (speech recognition, voices for the configured
language, audio streaming) and writes hints into the log and the parent panel when a chosen
provider cannot work.

<details>
<summary>Manual install</summary>

```powershell
git clone https://github.com/nickllama/roblox-voice-buddy C:\Robo
cd C:\Robo
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
claude auth login        # open the link on your own PC, paste the code here
```

Then set `language` and `parentPin` in `config\config.json` and run `scripts\launch.ps1`.
</details>

### Updates

Robo checks GitHub every 10 minutes and, when idle, pulls changes and restarts
itself. The parent panel has "Check" and "Update now" buttons.

- **Public** repository: nothing to configure.
- **Private** repository: the child's PC needs a read-only token.
  GitHub → Settings → Developer settings → Fine-grained tokens → access to the one
  repository, permission Contents: Read-only. Then, once:
  `git remote set-url origin https://<TOKEN>@github.com/nickllama/roblox-voice-buddy`.

### Secrets

Secrets (PIN, ElevenLabs and Deepgram keys) live only in `config\config.json`, which
is not committed to git. The child's name and personal prompt edits go into
`config\prompt.local.md`, also outside git. Before a commit, `npm run check-secrets`
scans tracked files for keys.

## Language

`config.language` in `config\config.json` is a BCP-47 tag (`"en-US"` by default in
`config.example.json`; set `"ru-RU"`, `"de-DE"` and so on as needed). It drives three things:

- the language of speech recognition and TTS in the browser (Web Speech API, Edge voices,
  Deepgram and ElevenLabs);
- the set of child-facing phrases: on-screen statuses and spoken system phrases such as
  "let me think" live in `server/src/i18n.ts` and `ui/i18n.js`, with `en` and `ru` shipped
  and `en` as the fallback;
- the first lines of the system prompt, telling Claude which language the child speaks and that every word is read aloud.

The system prompt `config/prompt.md` is written in English; parents add their own notes in
`config/prompt.local.md` in any language. Sample child utterances for prompt runs are in
`tests/phrases.en.json` and `tests/phrases.ru.json`.

Edge TTS picks a voice matching the regular expression `tts.edge.voiceMatch`
(default `Online \(Natural\)`) among the voices whose `lang` matches `config.language`.

## Checks and keys: the parent panel

Open `http://localhost:3777/parent` (or `http://<child-pc-ip>:3777/parent` from your phone), enter
the PIN. The **Health** block shows, with what to do when something is off:

- Claude: signed in or not (`claude auth status` on the child's PC);
- Roblox Studio: launcher found, and whether an open place answers (Robo asks Studio's MCP launcher
  directly at start and every minute, no Claude involved);
- the Robo window: speech recognition available, voices for the configured language, audio streaming;
- recognition: the last error with a hint, or what the last test heard.

**Test voice** speaks a phrase on the child's PC. **Test recognition** listens for four seconds on the
child's PC and shows the words it heard. **Settings** holds the child's language, the Claude model
(applied at once when Robo is idle, the conversation continues), whether Robo may playtest on its own
(off by default: it plays the game only when the child asks to check it), the play time and break
(45 minutes from the child's first command, then a 15-minute break with a countdown on the child's page;
"Break now" and "Continue now" buttons; the game is kept), the Robo window size and corner
(applied on the next start), the recognition and speech providers, and the Deepgram, Fish Audio and
ElevenLabs keys; keys are written only to `config\config.json`.

Health also shows Claude usage: tokens in and out, steps and duration of the last request, totals since
start with the SDK's list-price estimate (a subscription is not billed per token), and the subscription
window with its reset time. **Days with Robo** is the per-day table kept across restarts in
`workspace\stats.json`: play time (gaps under 10 minutes between the child's commands and Robo's answers,
so time away is not counted), first and last command, commands, requests, steps, tokens, cost estimate
and breaks, for the last 14 days with a total line. **Publish game** sends Alt+P to the Studio window. When the child asks Robo
to publish, Robo gets the game ready (spawn point, one playtest) and asks you in the panel with a one-line
summary; "Allow" sends the same Alt+P, "No" or two minutes of silence means not now. Claude has no other
way to publish.

Typical fixes: `network` from browser recognition means Windows blocks online speech
(Settings → Privacy & security → Speech → Online speech recognition) or there is no internet;
otherwise paste a Deepgram key and pick Deepgram. Edge voices silent or missing for the language:
pick **Fish Audio** (free `s2.1-pro-free` model, key from fish.audio, optional voice ID) or
**ElevenLabs** (paid, key and voice ID). Both stream audio while Claude is still talking.

For scripting: `scripts\check-studio.ps1` runs one Claude call against Studio and prints the raw
MCP status.

## Parent mode

`http://localhost:3777/parent` on the same computer, or `http://<child-pc-ip>:3777/parent`
from a phone on the home network. The PIN is in `config\config.json`. The panel has the log,
the prompt, permissions, "new game", a text hint to Robo, and "allow deletion?" questions.

On the child's page, parent mode opens with a long press in the top right corner.

## Development

```bash
npm install
npm run typecheck
npm test             # unit: sentence splitting, text cleaning, Luau guard
npm run dev          # server with restart on edits
npm run dev:fake     # same, but a fake Studio from tools/ instead of Roblox Studio
npm run e2e          # live run: real Claude + fake Studio (requires Claude Code login)
```

The fake Studio (`tools/fake-studio-mcp.mjs`) mirrors the real tool names, keeps the
object tree in memory and writes calls to the file named by `ROBO_FAKE_LOG`. With it you
can develop and test the prompt on Mac or Linux without Roblox.

Config: `config/config.example.json` is in git, `config/config.json` is local.
Prompt: `config/prompt.md` is in git, `config/prompt.local.md` holds the parent's edits.

## License

MIT, see [LICENSE](LICENSE).

## Structure

```
server/src/agent      Agent SDK session, event parsing, sentence splitting
server/src/policy     Studio tool allowlist, canUseTool, Luau guard
server/src/speech     ElevenLabs and Fish Audio TTS (WebSocket streaming), Deepgram STT (streaming), TTS cache
server/src/i18n.ts    child-facing phrases per language (en, ru)
server/src/hotkey.ts  global push-to-talk key (uiohook-napi)
ui/                   child's page, browser STT/TTS, parent panel, ui/i18n.js
scripts/              install, launch, shortcut, always-on-top, Studio check
config/               example config, prompt
tests/                unit tests and sample phrases (en, ru)
docs/plan.md          plan and architecture
```
