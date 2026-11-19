import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MathTrainer, lastNumber, hasCommand, parseTables } from "../server/src/math.ts";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "robo-math-")), "math.json");

test("math: numbers said aloud, in digits or words, Russian and English", () => {
  assert.equal(lastNumber("12"), 12);
  assert.equal(lastNumber("девять"), 9);
  assert.equal(lastNumber("Это будет сорок два."), 42);
  assert.equal(lastNumber("три умножить на три девять"), 9);
  assert.equal(lastNumber("forty-two"), 42);
  assert.equal(lastNumber("twenty"), 20);
  assert.equal(lastNumber("построй дом"), null);
});

test("math: an answer with a command in it also goes to Claude, a bare answer does not", () => {
  assert.equal(hasCommand("девять"), false);
  assert.equal(hasCommand("это будет 12"), false);
  assert.equal(hasCommand("три умножить на три девять"), false);
  assert.equal(hasCommand("девять, а теперь построй большой замок"), true);
});

test("math: tables from the panel", () => {
  assert.deepEqual(parseTables("5, 2,2; 11 x 3"), [2, 3, 5]);
  assert.deepEqual(parseTables([4, "7"]), [4, 7]);
});

test("math: teach after one command, ask after the next, a right answer earns a star and teaches the next fact", () => {
  const m = new MathTrainer(file());
  assert.deepEqual(m.afterCommand([2]), { kind: "line", line: "teach", fact: { a: 2, b: 2 } });
  assert.equal(m.expectsAnswer, false);
  assert.equal(m.answer("4", [2]), null); // nothing was asked yet
  assert.deepEqual(m.afterCommand([2]), { kind: "line", line: "ask", fact: { a: 2, b: 2 } });
  assert.equal(m.expectsAnswer, true);
  assert.equal(m.answer("построй дом", [2]), null); // no number: an ordinary command
  const a = m.answer("четыре", [2]);
  assert.equal(a.right, true);
  assert.equal(a.stars, 1);
  assert.deepEqual(a.next, { a: 2, b: 3 });
  // the next fact was taught with the feedback: the next command asks it
  assert.deepEqual(m.afterCommand([2]), { kind: "line", line: "ask", fact: { a: 2, b: 3 } });
});

test("math: a wrong answer gets no star and the same fact is asked again after the next command", () => {
  const m = new MathTrainer(file());
  m.afterCommand([3]); m.afterCommand([3]);
  const a = m.answer("пять", [3]);
  assert.equal(a.right, false);
  assert.equal(a.stars, 0);
  assert.equal(a.next, null);
  assert.deepEqual(m.afterCommand([3]), { kind: "line", line: "ask", fact: { a: 3, b: 2 } });
});

test("math: a question the child ignores is asked twice more, then dropped", () => {
  const m = new MathTrainer(file());
  m.afterCommand([2]); m.afterCommand([2]); // taught, asked
  assert.equal(m.afterCommand([2]).line, "ask");
  assert.equal(m.afterCommand([2]).line, "ask");
  const s = m.afterCommand([2]);
  assert.equal(s.line, "teach");
});

test("math: a fact answered wrong comes back before new ones, and progress survives a restart", () => {
  const f = file();
  const m = new MathTrainer(f);
  m.afterCommand([2]); m.afterCommand([2]);
  m.answer("5", [2]); // 2x2 wrong
  m.afterCommand([2]);
  m.answer("4", [2]); // 2x2 right now, box 1, due after 3 questions
  const again = new MathTrainer(f);
  assert.equal(again.stars, 1);
  const p = again.progress([2]);
  assert.equal(p.tables[0].total, 8);
  assert.equal(p.tables[0].learned, 0);
});

test("math: the bonus comes every N stars", () => {
  const m = new MathTrainer(file(), 2);
  const bonuses = [];
  m.afterCommand([5]);
  for (let i = 0; i < 4; i++) {
    m.afterCommand([5]);
    const p = m.answer("0", [5]); // wrong on purpose? no: answer right below
    bonuses.push(p.bonus);
  }
  assert.deepEqual(bonuses, [false, false, false, false]);
  const m2 = new MathTrainer(file(), 2);
  const got = [];
  m2.afterCommand([5]);
  for (let i = 0; i < 4; i++) {
    const asked = m2.afterCommand([5]);
    got.push(m2.answer(String(asked.fact.a * asked.fact.b), [5]).bonus);
  }
  assert.deepEqual(got, [false, true, false, true]);
});
