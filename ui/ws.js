/** Connection to the local server with automatic reconnect. onOpen gets true on a reconnect (the server restarted). */
export function connect(onEvent, onOpen) {
  let ws;
  let timer;
  let opened = 0;
  const queue = [];
  function open() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => { opened += 1; for (const m of queue.splice(0)) ws.send(m); onOpen?.(opened > 1); };
    ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { clearTimeout(timer); timer = setTimeout(open, 1000); };
    ws.onerror = () => ws.close();
  }
  open();
  return {
    send(obj) {
      const m = JSON.stringify(obj);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(m); else queue.push(m);
    },
    /** A binary frame (a recording chunk). Not queued without a connection: a recording without its start is useless. */
    sendBinary(buf) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
    },
  };
}
