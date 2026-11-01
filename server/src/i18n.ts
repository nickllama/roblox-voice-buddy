/**
 * Child-facing phrases spoken by the server, by language.
 * Picked by the two-letter prefix of config.language; fallback is English.
 * When adding a phrase, add it to every language here and to ui/i18n.js if the page needs it.
 */
export interface Phrases {
  notHeard: string;
  openStudio: string;
  waitBuilding: string;
  thinking: string;
  stillBuilding: string;
  tired: string;
  wentWrong: string;
  needRest: string;
  sessionOver: string;
  newGame: string;
  updating: string;
  cannotDoThat: string;
  askParent: string;
  /** Replacement words used by cleanForSpeech for object paths and tool names. */
  objectWord: string;
  toolWord: string;
  /** Language name for the line appended to the system prompt. */
  languageName: string;
}

const en: Phrases = {
  notHeard: "I didn't catch that. Say it again.",
  openStudio: "Open your game in Roblox Studio and press the button again.",
  waitBuilding: "Wait, I'm still building.",
  thinking: "Let me think.",
  stillBuilding: "Still building.",
  tired: "I'm a little tired. Let's try something simpler.",
  wentWrong: "Something went wrong. Try again.",
  needRest: "I need a rest. Call a grown-up.",
  sessionOver: "That's enough for today. Great work! Let's go rest.",
  newGame: "Let's start a new game!",
  updating: "One second, I'm updating.",
  cannotDoThat: "I can't do that one. Let's try a different way.",
  askParent: "Ask a grown-up if that's okay.",
  objectWord: "object",
  toolWord: "tool",
  languageName: "English",
};

const ru: Phrases = {
  notHeard: "Я не расслышал. Скажи ещё раз.",
  openStudio: "Открой свою игру в Roblox Studio и нажми кнопку ещё раз.",
  waitBuilding: "Подожди, я ещё строю.",
  thinking: "Сейчас подумаю.",
  stillBuilding: "Ещё строю.",
  tired: "Я немного устал. Давай попробуем проще.",
  wentWrong: "Что-то пошло не так. Попробуй ещё раз.",
  needRest: "Мне нужен отдых. Позови маму или папу.",
  sessionOver: "На сегодня хватит. Отличная работа! Пойдём отдыхать.",
  newGame: "Начинаем новую игру!",
  updating: "Секундочку, я обновляюсь.",
  cannotDoThat: "Это я делать не умею, давай по-другому.",
  askParent: "Спроси маму или папу, можно ли.",
  objectWord: "объект",
  toolWord: "инструмент",
  languageName: "Russian",
};

const TABLE: Record<string, Phrases> = { en, ru };

export function phrases(language: string): Phrases {
  return TABLE[(language || "en").slice(0, 2).toLowerCase()] ?? en;
}
