import { test } from "node:test";
import assert from "node:assert/strict";
import { isStopCommand } from "../server/src/stopCommand.ts";
import { HandsFree } from "../server/src/handsFree.ts";

test("stop: the ways a child says stop", () => {
  for (const said of ["Прекрати!", "стоп", "Останови стройку.", "Хватит строить", "Робо, остановись", "перестань пожалуйста", "Stop!", "stop building now", "Robo, cancel that", "отмена"]) {
    assert.equal(isStopCommand(said), true, said);
  }
});

test("stop: a command that only contains the word is still a command", () => {
  for (const said of ["сделай знак стоп", "поставь стоп-сигнал на дороге", "put a stop sign here", "не останавливайся", "don't stop", "построй дом и стоп", "хватит одного окна, добавь дверь"]) {
    assert.equal(isStopCommand(said), false, said);
  }
});

test("stop: the name with stop is the sleep phrase in hands-free, plain stop is not", () => {
  const hf = new HandsFree();
  assert.equal(hf.isSleepPhrase("Стоп, Робо"), true);
  assert.equal(hf.isSleepPhrase("Робо, пока"), true);
  assert.equal(hf.isSleepPhrase("прекрати"), false);
  assert.equal(hf.isSleepPhrase("останови стройку"), false);
});
