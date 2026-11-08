/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 14 days of hourly counts per server for the dashboard's sparklines: members, messages sent (people, not bots) and
 * people in voice. Counts only, never who or what. Older rows are removed.
 */
export const HOUR = 3600000;
export const KEEP_DAYS = 14;

export class StatHistory {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db; this.now = now;
    this.pending = new Map(); // guild id -> messages not written yet
  }
  /** One message from a person. */
  count(guildId) { if (guildId) this.pending.set(guildId, (this.pending.get(guildId) ?? 0) + 1); }
  /** Writes the counts so far into this hour's row, with the server's current members and voice numbers. */
  record(guildId, { members = null, voice = null } = {}) {
    const hour = Math.floor(this.now() / HOUR);
    const msgs = this.pending.get(guildId) ?? 0;
    this.pending.delete(guildId);
    this.db.q(`INSERT INTO stat_history (guild_id, hour, members, messages, voice) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, hour) DO UPDATE SET members = COALESCE(excluded.members, members), voice = COALESCE(excluded.voice, voice), messages = messages + excluded.messages`)
      .run(guildId, hour, members, msgs, voice);
  }
  /** Samples every server the client is in, then drops rows older than 14 days. */
  sampleAll(client) {
    for (const [id, g] of client.guilds.cache) {
      try {
        const voice = g.voiceStates?.cache?.filter?.((v) => v.channelId && !v.member?.user?.bot).size ?? null;
        this.record(id, { members: g.memberCount ?? null, voice });
      } catch { /* one server failing should not stop the rest */ }
    }
    this.prune();
  }
  prune() { this.db.q('DELETE FROM stat_history WHERE hour < ?').run(Math.floor(this.now() / HOUR) - KEEP_DAYS * 24); }
  forget(guildId) { this.pending.delete(guildId); this.db.q('DELETE FROM stat_history WHERE guild_id = ?').run(guildId); }
  /** The last 14 days for one server: one point per hour, oldest first, gaps filled (members carried forward). */
  series(guildId) {
    const end = Math.floor(this.now() / HOUR);
    const start = end - KEEP_DAYS * 24 + 1;
    const rows = new Map(this.db.q('SELECT hour, members, messages, voice FROM stat_history WHERE guild_id = ? AND hour >= ? ORDER BY hour').all(guildId, start).map((r) => [Number(r.hour), r]));
    const first = rows.size ? Math.min(...rows.keys()) : end;
    const out = { from: first * HOUR, hourMs: HOUR, members: [], messages: [], voice: [] };
    let lastMembers = null;
    for (let h = first; h <= end; h++) {
      const r = rows.get(h);
      if (r?.members != null) lastMembers = Number(r.members);
      out.members.push(lastMembers);
      out.messages.push(Number(r?.messages ?? 0) + (h === end ? (this.pending.get(guildId) ?? 0) : 0));
      out.voice.push(r?.voice != null ? Number(r.voice) : (r ? 0 : null));
    }
    return out;
  }
}
