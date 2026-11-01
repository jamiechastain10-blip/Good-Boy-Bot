/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The bot's side of the conversation with the supervisor (src/supervisor.js). When the bot was started by the
 * supervisor it has an IPC channel to its parent: it reports that it is alive and ready, answers a shutdown request,
 * and can ask the supervisor about updates. Started with plain `npm start` there is no channel and all of this is off.
 */
export const HEARTBEAT_MS = 5000;

export function connectSupervisor({ proc = process, version, getStatus = () => ({}), onShutdown = () => {}, onControl = null, heartbeatMs = HEARTBEAT_MS, requestTimeoutMs = 30000 } = {}) {
  if (typeof proc.send !== 'function') return null;
  let timer = null; let nextId = 1; let closed = false;
  const pending = new Map();
  const send = (msg) => { if (closed || !proc.connected) return false; try { proc.send(msg); return true; } catch { return false; } };
  const beat = () => send({ type: 'status', at: Date.now(), ...getStatus() });

  proc.on('message', (m) => {
    if (m?.type === 'shutdown') onShutdown('supervisor asked the bot to stop');
    else if (m?.type === 'update-reply' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.result); }
    // The desktop app asks the running bot to do something (turn a module on, load a new one), through the supervisor.
    else if (m?.type === 'control' && m.id != null) {
      Promise.resolve().then(() => (onControl ? onControl(String(m.action ?? ''), m.payload ?? {}) : { ok: false, error: 'This bot does not take requests.' }))
        .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
        .then((result) => send({ type: 'control-reply', id: m.id, result }));
    }
  });
  // If the supervisor goes away, a bot with no parent should stop rather than run unattended.
  proc.on('disconnect', () => { closed = true; clearInterval(timer); for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'The supervisor is gone.' }); } pending.clear(); onShutdown('the supervisor disconnected'); });

  send({ type: 'hello', pid: proc.pid, version });
  timer = setInterval(beat, heartbeatMs); timer.unref?.();

  return {
    ready() { send({ type: 'ready', version }); beat(); },
    /** Ask the supervisor to do something about updates: 'status' | 'check' | 'apply'. */
    request(action, payload = {}) {
      return new Promise((resolve) => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'The supervisor did not answer in time.' }); }, requestTimeoutMs);
        t.unref?.();
        pending.set(id, { resolve, timer: t });
        if (!send({ type: 'update-request', id, action, payload })) { pending.delete(id); clearTimeout(t); resolve({ ok: false, error: 'The supervisor is not reachable.' }); }
      });
    },
    close() { closed = true; clearInterval(timer); },
  };
}
