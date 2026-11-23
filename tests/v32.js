/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.2 tests: your own art from the dashboard.
 */
import assert from 'node:assert/strict';

export default async function runV32Tests({ test }) {
  const { makeWorld } = await import('./features.js');
  const { startDashboard } = await import('../src/dashboard/server.js');
  const ART = await import('../src/customart.js');

  console.log('\n3.2 your art on the dashboard');
  await test('dashboard art: the bot owner uploads, sees, replaces and removes pictures; others are refused; only real pictures; no path tricks; /rp uses the picture', async () => {
    const w = await makeWorld(['roleplay', 'critters']).load();
    w.mm.ownerIds.add('owner9');
    const dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info() {}, warn() {}, error() {} }, perms: w.perms, port: 0, host: '127.0.0.1', version: '3.2.0' });
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'); const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    try {
      const mk = (sid, id, name) => dash.sessions.set(sid, { user: { id, username: name, avatar: null }, guilds: [], expires: Date.now() + 3600000, created: Date.now() });
      mk('s-owner', 'owner9', 'Basic'); mk('s-admin', 'admin9', 'Juno');
      const base = `http://127.0.0.1:${dash.port}`;
      const get = (sid, p) => fetch(base + p, { headers: { cookie: `gb_sid=${sid}` } });
      const send = (sid, p, body, extra = {}) => fetch(base + p, { method: 'POST', headers: { cookie: `gb_sid=${sid}`, 'X-GoodBoy': '1', 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...extra }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
      // who may
      assert.equal((await get('nobody', '/api/art')).status, 401);
      assert.equal((await get('s-admin', '/api/art')).status, 403, 'a server admin who is not the bot owner');
      assert.equal((await send('s-admin', '/api/art/rp/boop', gif)).status, 403);
      assert.equal((await fetch(`${base}/api/art/rp/boop`, { method: 'POST', headers: { cookie: 'gb_sid=s-owner' }, body: gif })).status, 403, 'another website cannot upload for you');
      // the list
      let d = await (await get('s-owner', '/api/art')).json();
      assert.deepEqual(d.kinds.map((k) => k.kind), ['rp', 'critters']);
      const boop = () => d.kinds[0].names.find((n) => n.name === 'boop');
      assert.equal(boop().title, 'Boop'); assert.ok(boop().emoji); assert.deepEqual(boop().files, []);
      assert.ok(d.kinds[1].names.some((n) => n.name === 'emberpup-sparkly' && /Sparkly/.test(n.title)));
      // upload
      let r = await send('s-owner', '/api/art/rp/boop', gif); assert.equal(r.status, 200);
      r = await send('s-owner', '/api/art/rp/boop', gif); assert.equal((await r.json()).files.length, 2, 'roleplay actions can have several');
      assert.match((await (await send('s-owner', '/api/art/rp/boop', Buffer.from('MZ not a picture at all'))).json()).error, /isn't a picture/);
      assert.equal((await send('s-owner', '/api/art/rp/notanaction', gif)).status, 404);
      assert.equal((await send('s-owner', '/api/art/secrets/boop', gif)).status, 404);
      d = await (await get('s-owner', '/api/art')).json();
      assert.equal(boop().files.length, 2);
      // see it
      const pic = await get('s-owner', `/api/art/rp/boop/file/${boop().files[0].file}`);
      assert.equal(pic.headers.get('content-type'), 'image/gif'); assert.ok(Buffer.from(await pic.arrayBuffer()).equals(gif));
      assert.equal((await get('s-admin', `/api/art/rp/boop/file/${boop().files[0].file}`)).status, 403);
      for (const bad of ['..%2F..%2Feclipse.db', '%2Fetc%2Fpasswd', 'nope.gif', '.hidden.png']) assert.equal((await get('s-owner', `/api/art/rp/boop/file/${bad}`)).status, 404, bad);
      // /rp now shows it
      const a = w.person('997000000000000011'), b = w.person('997000000000000012');
      const hugs = w.ix({ command: 'rp', member: a, channel: w.channel('chat'), opts: { action: 'boop', member: b.user } }); await w.mm.handleCommand(hugs);
      assert.ok((hugs.replies[0] ?? hugs.edits[0]).files[0].attachment.equals(gif), "the owner's GIF is used");
      // a critter has one picture: a new one replaces it
      await send('s-owner', '/api/art/critters/emberpup?replace=1', png);
      await new Promise((ok) => setTimeout(ok, 5));
      r = await (await send('s-owner', '/api/art/critters/emberpup?replace=1', gif)).json();
      assert.equal(r.files.length, 1); assert.match(r.files[0], /\.gif$/, 'the new one stays, the old one goes');
      // remove one, then all
      r = await (await send('s-owner', '/api/art/rp/boop/remove', { file: boop().files[0].file })).json(); assert.equal(r.files.length, 1);
      assert.match((await (await send('s-owner', '/api/art/rp/boop/remove', { file: '../../x.gif' })).json()).error, /already removed/);
      r = await (await send('s-owner', '/api/art/rp/boop/remove', { all: true })).json(); assert.deepEqual(r.files, []);
      assert.equal(ART.pickArt('rp', 'boop'), null, "back to Good Boy's own");
    } finally { ART.clearArt('rp', 'boop'); ART.clearArt('critters', 'emberpup'); dash.close(); }
  });
}
