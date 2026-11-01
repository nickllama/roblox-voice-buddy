/**
 * Проигрыватель потоковой озвучки: сервер присылает MP3 кусками (audio.begin / audio.chunk / audio.end),
 * мы играем их через MediaSource, не дожидаясь конца. Сегменты (по одному на текстовый блок ответа)
 * идут по очереди. Если MediaSource не умеет audio/mpeg, сегмент играется целиком по окончании.
 */
export function createStreamPlayer({ audioEl, onStart, onEnd }) {
  const mse = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  const segments = []; // { id, chunks: Uint8Array[], ended }
  let current = null;  // { seg, ms, sb, url }
  const idleWaiters = [];

  const find = (id) => segments.find((s) => s.id === id);
  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  function begin(id) { segments.push({ id, chunks: [], ended: false }); }
  function chunk(id, b64) { const s = find(id); if (!s) return; s.chunks.push(decode(b64)); pump(); }
  function end(id) { const s = find(id); if (!s) return; s.ended = true; pump(); }

  function pump() {
    if (current) { feed(); return; }
    while (segments.length && segments[0].ended && segments[0].chunks.length === 0) segments.shift();
    if (!segments.length) { fireIdle(); return; }
    const seg = segments[0];
    if (!seg.chunks.length) return;           // ждём первый кусок
    if (mse) startMse(seg); else if (seg.ended) startBlob(seg);
  }

  function startMse(seg) {
    const ms = new MediaSource();
    current = { seg, ms, sb: null, url: URL.createObjectURL(ms) };
    ms.addEventListener("sourceopen", () => {
      if (current?.ms !== ms) return;
      try {
        current.sb = ms.addSourceBuffer("audio/mpeg");
        current.sb.addEventListener("updateend", feed);
        feed();
      } catch (e) { console.warn("player", e); finishSegment(); }
    }, { once: true });
    audioEl.onended = finishSegment;
    audioEl.onerror = finishSegment;
    audioEl.src = current.url;
    audioEl.play().catch(() => {});
    onStart?.(seg);
  }

  function feed() {
    const c = current;
    if (!c || !c.sb || c.sb.updating) return;
    if (c.seg.chunks.length) { try { c.sb.appendBuffer(c.seg.chunks.shift()); } catch (e) { console.warn("player", e); finishSegment(); } return; }
    if (c.seg.ended && c.ms.readyState === "open") { try { c.ms.endOfStream(); } catch {} }
  }

  function startBlob(seg) {
    current = { seg, ms: null, sb: null, url: URL.createObjectURL(new Blob(seg.chunks, { type: "audio/mpeg" })) };
    seg.chunks = [];
    audioEl.onended = finishSegment;
    audioEl.onerror = finishSegment;
    audioEl.src = current.url;
    audioEl.play().catch(finishSegment);
    onStart?.(seg);
  }

  function finishSegment() {
    const c = current;
    if (!c) return;
    current = null;
    try { URL.revokeObjectURL(c.url); } catch {}
    const i = segments.indexOf(c.seg);
    if (i >= 0) segments.splice(i, 1);
    pump();
  }

  function fireIdle() {
    for (const w of idleWaiters.splice(0)) { try { w(); } catch {} }
    onEnd?.();
  }

  return {
    begin, chunk, end,
    /** Идёт звук или есть куски в очереди. */
    get busy() { return current !== null || segments.some((s) => s.chunks.length > 0); },
    /** Вызвать, когда очередь опустеет (сразу, если пусто). */
    whenIdle(cb) { if (this.busy) idleWaiters.push(cb); else cb(); },
    cancel() {
      segments.length = 0;
      idleWaiters.length = 0;
      const c = current;
      current = null;
      try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {}
      if (c) { try { URL.revokeObjectURL(c.url); } catch {} }
    },
  };
}
