import { test } from "node:test";
import assert from "node:assert/strict";
import { requestPublish } from "../server/src/agent/roboTools.ts";

function actions(publishImpl) {
  const spoken = [];
  return {
    spoken,
    publish: publishImpl,
    notice: (t) => spoken.push(t),
    askParentPhrase: () => "ask a grown-up",
  };
}

test("request_publish: the parent's yes runs the publish", async () => {
  let asked = "";
  let published = 0;
  const gate = { ask: async (q) => { asked = q; return true; } };
  const a = actions(async () => { published += 1; return "sent"; });
  const out = await requestPublish("a lava parkour with three checkpoints", gate, a);
  assert.match(asked, /lava parkour/);
  assert.equal(published, 1);
  assert.match(out, /approved/);
  assert.deepEqual(a.spoken, ["ask a grown-up"]);
});

test("request_publish: no answer or a no never publishes", async () => {
  let published = 0;
  const gate = { ask: async () => false };
  const a = actions(async () => { published += 1; return "sent"; });
  const out = await requestPublish("", gate, a);
  assert.equal(published, 0);
  assert.match(out, /Not published/);
});

test("request_publish: a failed publish is reported, not thrown", async () => {
  const gate = { ask: async () => true };
  const a = actions(async () => { throw new Error("Studio window not found"); });
  const out = await requestPublish("x", gate, a);
  assert.match(out, /by hand/);
});
