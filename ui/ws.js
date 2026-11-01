/** Подключение к локальному серверу с автопереподключением. */
export function connect(onEvent, onOpen) {
  let ws;
  let timer;
  const queue = [];
  function open() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => { for (const m of queue.splice(0)) ws.send(m); onOpen?.(); };
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
    /** Бинарный кадр (кусок записи). Без соединения не копим: запись без начала бесполезна. */
    sendBinary(buf) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
    },
  };
}
