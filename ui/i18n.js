/**
 * Strings shown on the child's page, by language. Picked by the two-letter prefix of
 * config.language; fallback is English. Keep in sync with server/src/i18n.ts.
 */
const UI = {
  en: {
    waking: "Robo is waking up…",
    idle: "Hold the button and talk",
    listen: "Listening…",
    think: "Thinking…",
    build: "Building…",
    speak: "",
    offline: "Robo is asleep. Call a grown-up.",
    ptt: "Hold and talk",
    stop: "Stop",
    studioOn: "Roblox Studio connected",
    studioOff: "Roblox Studio not connected",
    sayNow: "Say something…",
    breakIn: "Resting. Back in {t}",
    breakParent: "Resting. A grown-up can let me continue.",
  },
  ru: {
    waking: "Робо просыпается…",
    idle: "Зажми кнопку и говори",
    listen: "Слушаю…",
    think: "Думаю…",
    build: "Строю…",
    speak: "",
    offline: "Робо спит. Позови родителей.",
    ptt: "Зажми и говори",
    stop: "Стоп",
    studioOn: "Roblox Studio подключена",
    studioOff: "Roblox Studio не подключена",
    sayNow: "Скажи что-нибудь…",
    breakIn: "Отдыхаю. Вернусь через {t}",
    breakParent: "Отдыхаю. Продолжить может взрослый.",
  },
};

export function uiStrings(language) {
  return UI[(language || "en").slice(0, 2).toLowerCase()] ?? UI.en;
}
