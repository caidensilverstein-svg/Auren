/* Tiny CDP client over the global WebSocket (Node >= 22). No dependencies.
 * Deliberately never sends Runtime.enable so the audit itself does not trip the
 * Runtime.enable detection it is trying to measure. */
export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl); const c = new CDP(ws);
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP connect timeout ' + wsUrl)), timeoutMs); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = (e) => { clearTimeout(t); rej(new Error('CDP ws error ' + (e.message || ''))); }; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message + ' (' + JSON.stringify(m.error.data || '') + ')')) : res(m.result); }
      else if (m.method) for (const h of c.handlers) h(m);
    };
    ws.onclose = () => { for (const { rej } of c.pending.values()) rej(new Error('CDP closed')); c.pending.clear(); };
    return c;
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); }, timeoutMs); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify(msg)); });
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

export async function browserWsUrl(hostPort) {
  const r = await fetch(`http://${hostPort}/json/version`); if (!r.ok) throw new Error('GET /json/version ' + r.status);
  const j = await r.json(); return { ws: j.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${hostPort}`), version: j };
}
