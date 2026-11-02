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
  /** {min} is replaced with the break length in minutes. */
  breakStart: string;
  breakOver: string;
  newGame: string;
  updating: string;
  cannotDoThat: string;
  askParent: string;
  /** Spoken when the parent presses "Test voice" in the panel. */
  voiceTest: string;
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
  sessionOver: "That's enough for today. Great work! Go run around or jump, let your body and your eyes rest.",
  breakStart: "Great work! Time for a break. Go run around or jump, let your body and your eyes rest. I'll be back in {min} minutes.",
  breakOver: "The break is over. You can keep going! Hold the button and talk.",
  newGame: "Let's start a new game!",
  updating: "One second, I'm updating.",
  cannotDoThat: "I can't do that one. Let's try a different way.",
  askParent: "Ask a grown-up if that's okay.",
  voiceTest: "Hi! I'm Robo. Let's build something together!",
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
  sessionOver: "На сегодня хватит. Отличная работа! Побегай или попрыгай, пусть тело и глазки отдохнут.",
  breakStart: "Отличная работа! Пора отдохнуть. Побегай или попрыгай, пусть тело и глазки отдохнут. Я вернусь через {min} минут.",
  breakOver: "Отдых закончился. Можешь продолжать! Зажми кнопку и говори.",
  newGame: "Начинаем новую игру!",
  updating: "Секундочку, я обновляюсь.",
  cannotDoThat: "Это я делать не умею, давай по-другому.",
  askParent: "Спроси маму или папу, можно ли.",
  voiceTest: "Привет! Я Робо. Давай что-нибудь построим!",
  objectWord: "объект",
  toolWord: "инструмент",
  languageName: "Russian",
};

const TABLE: Record<string, Phrases> = { en, ru };

export function phrases(language: string): Phrases {
  return TABLE[(language || "en").slice(0, 2).toLowerCase()] ?? en;
}
