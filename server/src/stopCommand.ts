/**
 * "Stop!", "Прекрати", "Останови стройку": the child wants Robo to stop what it is doing right now.
 * Works with the button and in hands-free mode, at any moment, also while Robo is talking.
 *
 * The phrase must consist of a stop word plus a few harmless words around it, so that a command which
 * merely contains the word ("сделай знак стоп", "put a stop sign here") is still a command, and
 * "не останавливайся" ("don't stop") is not a stop.
 */
const STOP = new Set([
  "стоп", "хватит", "прекрати", "прекращай", "прекратить", "останови", "остановись", "остановить", "остановитесь",
  "перестань", "перестать", "отмена", "отмени", "отменить", "довольно", "стой",
  "stop", "cancel", "enough", "quit", "halt",
]);
/** Words that may come with a stop word: "останови стройку, пожалуйста", "Robo, stop building now". */
const ALONG = new Set([
  "стройку", "строить", "строительство", "стройка", "это", "всё", "все", "пожалуйста", "сейчас", "давай", "уже", "ну", "срочно",
  "робо", "робот", "роба", "рабо", "робу", "ой", "эй", "всем", "делать",
  "building", "build", "it", "that", "now", "please", "everything", "robo", "robot", "hey", "right", "the", "doing",
]);
const NOT = new Set(["не", "не надо", "don't", "dont", "do", "not", "never"]);

const norm = (w: string) => w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}']/gu, "");

export function isStopCommand(text: string): boolean {
  const words = text.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (!words.some((w) => STOP.has(w))) return false;
  if (words.some((w) => NOT.has(w))) return false;
  return words.every((w) => STOP.has(w) || ALONG.has(w));
}
