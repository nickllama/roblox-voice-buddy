/**
 * Child-facing phrases spoken by the server, by language.
 * Picked by the two-letter prefix of config.language; fallback is English.
 * When adding a phrase, add it to every language here and to ui/i18n.js if the page needs it.
 */
export interface Phrases {
  /** Robo's name as it is written in this language; given to speech recognition as a word to listen for. */
  name: string;
  notHeard: string;
  openStudio: string;
  waitBuilding: string;
  thinking: string;
  stillBuilding: string;
  tired: string;
  wentWrong: string;
  needRest: string;
  sessionOver: string;
  /** {min} is replaced with the break length: the number and the word, "15 минут", "2 minutes" (see minutes()). */
  breakStart: string;
  breakOver: string;
  newGame: string;
  updating: string;
  cannotDoThat: string;
  askParent: string;
  /** Spoken when the parent presses "Test voice" in the panel. */
  voiceTest: string;
  /** The word for minutes after a number: one, few (2-4 in Russian), many. */
  minuteForms: [string, string, string];
  /** Bedtime: the warning ({min}: minutes left, number and word) and good night. */
  bedWarn: string;
  bedNow: string;
  /** The child said "stop": while Robo was working, and when there was nothing to stop. */
  stopBuild: string;
  nothingToStop: string;
  /** Multiplication practice. {a} {b} are the factors, {c} the product, {stars} the star count. */
  mathTeach: string;
  mathAsk: string;
  mathRight: string;
  mathWrong: string;
  /** Hands-free mode: the answer to the wake phrase, and to the stop phrase. */
  handsFreeHello: string;
  handsFreeBye: string;
  /** Replacement words used by cleanForSpeech for object paths and tool names. */
  objectWord: string;
  toolWord: string;
  /** Language name for the line appended to the system prompt. */
  languageName: string;
}

const en: Phrases = {
  name: "Robo",
  notHeard: "I didn't catch that. Say it again.",
  openStudio: "Open your game in Roblox Studio and press the button again.",
  waitBuilding: "Wait, I'm still building.",
  thinking: "Let me think.",
  stillBuilding: "Still building.",
  tired: "I'm a little tired. Let's try something simpler.",
  wentWrong: "Something went wrong. Try again.",
  needRest: "I need a rest. Call a grown-up.",
  sessionOver: "That's enough for today. Great work! Go run around or jump, let your body and your eyes rest.",
  breakStart: "Great work! Time for a break. Go run around or jump, let your body and your eyes rest. I'll be back in {min}.",
  breakOver: "The break is over. You can keep going! Hold the button and talk.",
  newGame: "Let's start a new game!",
  updating: "One second, I'm updating.",
  cannotDoThat: "I can't do that one. Let's try a different way.",
  askParent: "Ask a grown-up if that's okay.",
  voiceTest: "Hi! I'm Robo. Let's build something together!",
  minuteForms: ["minute", "minutes", "minutes"],
  bedWarn: "In {min} it's time for bed. Let's finish what we're building.",
  bedNow: "Time for bed! Good night, see you tomorrow.",
  stopBuild: "Okay, stopping the build.",
  nothingToStop: "Okay. I'm not building anything right now.",
  mathTeach: "Remember: {a} times {b} is {c}. Next time I'll ask you!",
  mathAsk: "Question for a star: what is {a} times {b}?",
  mathRight: "Right, {c}! Here's a star. You have {stars} stars.",
  mathWrong: "Almost! {a} times {b} is {c}. I'll ask again.",
  handsFreeHello: "Hi! I'm listening.",
  handsFreeBye: "Bye! Call me when you need me.",
  objectWord: "object",
  toolWord: "tool",
  languageName: "English",
};

const ru: Phrases = {
  name: "Робо",
  notHeard: "Я не расслышал. Скажи ещё раз.",
  openStudio: "Открой свою игру в Roblox Studio и нажми кнопку ещё раз.",
  waitBuilding: "Подожди, я ещё строю.",
  thinking: "Сейчас подумаю.",
  stillBuilding: "Ещё строю.",
  tired: "Я немного устал. Давай попробуем проще.",
  wentWrong: "Что-то пошло не так. Попробуй ещё раз.",
  needRest: "Мне нужен отдых. Позови маму или папу.",
  sessionOver: "На сегодня хватит. Отличная работа! Побегай или попрыгай, пусть тело и глазки отдохнут.",
  breakStart: "Отличная работа! Пора отдохнуть. Побегай или попрыгай, пусть тело и глазки отдохнут. Я вернусь через {min}.",
  breakOver: "Отдых закончился. Можешь продолжать! Зажми кнопку и говори.",
  newGame: "Начинаем новую игру!",
  updating: "Секундочку, я обновляюсь.",
  cannotDoThat: "Это я делать не умею, давай по-другому.",
  askParent: "Спроси маму или папу, можно ли.",
  voiceTest: "Привет! Я Робо. Давай что-нибудь построим!",
  minuteForms: ["минуту", "минуты", "минут"],
  bedWarn: "Через {min} пора спать. Давай доделаем то, что строим.",
  bedNow: "Пора спать! Спокойной ночи, увидимся завтра.",
  stopBuild: "Хорошо, останавливаю стройку.",
  nothingToStop: "Хорошо. Я сейчас ничего не строю.",
  mathTeach: "Запомни: {a} умножить на {b} будет {c}. В следующий раз спрошу!",
  mathAsk: "Вопрос на звезду: сколько будет {a} умножить на {b}?",
  mathRight: "Правильно, {c}! Держи звезду. Звёзд у тебя: {stars}.",
  mathWrong: "Почти! {a} умножить на {b} будет {c}. Спрошу ещё раз.",
  handsFreeHello: "Привет! Я слушаю.",
  handsFreeBye: "Пока! Позови меня, когда понадоблюсь.",
  objectWord: "объект",
  toolWord: "инструмент",
  languageName: "Russian",
};

const TABLE: Record<string, Phrases> = { en, ru };

/** "1 минуту", "3 минуты", "15 минут", "21 минуту"; English needs only one and many. */
export function minutes(n: number, p: Phrases): string {
  const [one, few, many] = p.minuteForms;
  const d = n % 10, dd = n % 100;
  const word = d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  return `${n} ${word}`;
}

export function phrases(language: string): Phrases {
  return TABLE[(language || "en").slice(0, 2).toLowerCase()] ?? en;
}
