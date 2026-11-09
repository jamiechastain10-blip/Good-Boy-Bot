/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { Hub, hubUrl } from './hub.js';
import { syncEmojis } from './emojis.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { logger } from './logger.js';
import { Database } from './db.js';
import { Permissions } from './permissions.js';
import { ApiQueue } from './queue.js';
import { ModuleManager, EVENT_GUILD } from './moduleManager.js';
import { builtins } from './builtins.js';
import { withVersionLine } from './about.js';
import { startDashboard } from './dashboard/server.js';
import { StatHistory } from './stats.js';
import { sleep } from './util.js';
import { connectSupervisor } from './ipc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// Data lives outside the code so a release can be replaced without touching it. The supervisor sets this; by default it is ./data.
const dataDir = path.resolve(process.env.GOODBOY_DATA_DIR || path.join(root, 'data'));

// ---- preflight -----------------------------------------------------------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nGood Boy needs Node.js 22.13 or newer (you have ${process.versions.node}).\nInstall the current LTS from https://nodejs.org and try again.\n`);
  process.exit(1);
}
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('\nNo DISCORD_TOKEN found. Run "npm run setup" to create your .env file, or copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

// ---- core services ---------------------------------------------------------
const db = new Database(path.join(dataDir, 'eclipse.db'));
const statHistory = new StatHistory(db);
const perms = new Permissions(db);
let liveClient = null;
let stopping = false;
// When started by the supervisor (npm run supervised) this reports health to it and listens for "stop". Otherwise null.
const link = connectSupervisor({
  version,
  getStatus: () => ({ ready: !!liveClient?.isReady?.(), guilds: liveClient?.guilds?.cache?.size ?? 0, rss: process.memoryUsage().rss, uptime: Math.round(process.uptime()), pingMs: liveClient?.ws?.ping ?? null }),
  onShutdown: (why) => shutdown(why),
  onControl: (action, payload) => control(action, payload),
});
// Modules someone added from the desktop app live outside the bot's own folder, so app updates never remove them.
const extraModules = process.env.GOODBOY_EXTRA_MODULES ? path.resolve(process.env.GOODBOY_EXTRA_MODULES) : null;

/** Requests from the desktop app (through the supervisor). Only these few actions exist. */
async function control(action, p = {}) {
  const guilds = [...(liveClient?.guilds?.cache?.values?.() ?? [])];
  const pickGuild = () => (p.guildId ? guilds.find((g) => g.id === String(p.guildId)) : guilds[0]) ?? null;
  if (action === 'modules') {
    const g = pickGuild();
    if (!g) return { ok: false, error: 'The bot is not in a server yet.' };
    return { ok: true, guildId: g.id, guildName: g.name, guilds: guilds.map((x) => ({ id: x.id, name: x.name })),
      modules: manager.describeForGuild(g.id).map((d) => ({ name: d.name, version: d.version, description: d.description, enabled: d.enabled, type: d.type ?? 'module', requires: d.requires?.module ?? null, status: d.status, commands: d.commands })),
      loadErrors: Object.fromEntries(manager.loadErrors) };
  }
  if (action === 'module-set') {
    const g = pickGuild();
    if (!g) return { ok: false, error: 'The bot is not in a server yet.' };
    const name = String(p.name ?? '');
    if (!manager.defs.has(name)) return { ok: false, error: `There is no module called ${name}.` };
    try {
      if (p.enabled) await manager.enable(g.id, name); else await manager.disable(g.id, name, { cascade: true });
      return { ok: true, name, enabled: !!p.enabled };
    } catch (e) { return { ok: false, error: e.code === 'REQUIREMENT' ? `${e.message}` : e.message }; }
  }
  if (action === 'module-inspect') {
    if (!extraModules) return { ok: false, error: 'Adding modules is not set up for this bot.' };
    const dir = path.resolve(extraModules, String(p.folder ?? ''));
    if (path.dirname(dir) !== extraModules) return { ok: false, error: 'That module is not in the added-modules folder.' };
    return manager.inspect(dir);
  }
  if (action === 'modules-load') {
    if (!extraModules) return { ok: false, error: 'Adding modules is not set up for this bot.' };
    return { ok: true, ...(await manager.loadNew(extraModules)) };
  }
  if (action === 'dashboard-login') {
    if (!dashboard?.localLogin) return { ok: false, error: 'The dashboard is not running.' };
    return dashboard.localLogin();
  }
  if (action === 'levels') {
    // The desktop app's Levels page: the same list as the dashboard, with names and pictures from Discord.
    const g = pickGuild();
    if (!g) return { ok: false, error: 'The bot is not in a server yet.' };
    if (!manager.isActive(g.id, 'community')) return { ok: false, error: 'Community is off in this server.' };
    return { ok: true, guildId: g.id, guildName: g.name, ...(await manager.runView(g.id, 'community', 'levels')) };
  }
  return { ok: false, error: 'Unknown request.' };
}
const queue = new ApiQueue();
const manager = new ModuleManager({ db, perms, queue, builtins, dataDir });
manager.version = version;
manager.rootDir = root;

// ---- intents: try everything, fall back gracefully if privileged ones are off ----
const BASE = ['Guilds', 'GuildModeration', 'GuildMessages', 'GuildMessageReactions', 'GuildVoiceStates', 'GuildInvites', 'DirectMessages']; // 3.1: invite tracking, modmail
const ATTEMPTS = [
  ['GuildMembers', 'MessageContent', 'GuildPresences'],
  ['GuildMembers', 'MessageContent'],
  ['GuildMembers'],
  [],
];

function wire(client) {
  liveClient = client;
  client.once(Events.ClientReady, () => onReady(client).catch((e) => logger.error(`Startup error: ${e.stack ?? e.message}`)));

  client.on(Events.GuildCreate, async (guild) => {
    try {
      db.upsertGuild(guild.id, guild.name);
      await manager.restoreGuild(guild.id);
      await manager.syncCommands(guild.id);
      logger.info(`Joined server "${guild.name}"`);
    } catch (e) { logger.error(`GuildCreate failed: ${e.message}`); }
  });

  client.on(Events.GuildDelete, async (guild) => {
    if (guild.available === false) return; // outage, not a removal
    await manager.unloadGuild(guild.id);
    logger.info(`Removed from server "${guild.name}" (data kept in case you re-add me)`);
  });

  // 3.1: modmail. A DM goes to the staff of the server the member shares with the bot (they pick if there are several).
  const pendingDMs = new Map(); // user id -> the message waiting for them to pick a server
  async function modmailServers(user) {
    const out = [];
    for (const [gid, g] of client.guilds.cache) {
      if (!manager.isActive(gid, 'modmail')) continue;
      const api = manager.ctx(gid, 'modmail').api('modmail');
      if (!api?.ready(gid)) continue;
      const member = g.members.cache.get(user.id) ?? await g.members.fetch(user.id).catch(() => null);
      if (member) out.push({ gid, name: g.name, open: api.hasOpen(gid, user.id), api });
    }
    return out;
  }
  client.on(Events.MessageCreate, async (message) => {
    if (message.guildId || message.author?.bot || message.system) return;
    try {
      const servers = await modmailServers(message.author);
      if (!servers.length) return;
      const open = servers.filter((s) => s.open);
      const target = open.length === 1 ? open[0] : servers.length === 1 ? servers[0] : null;
      if (target) { await target.api.fromDM(target.gid, message); return; }
      pendingDMs.set(message.author.id, message);
      const { ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');
      await message.reply({ content: 'Which server\'s staff is this for?', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('mmpick')
        .setPlaceholder('Pick a server').addOptions(servers.slice(0, 25).map((s) => ({ label: s.name.slice(0, 100), value: s.gid }))))] }).catch(() => {});
    } catch (e) { await message.reply(e.name === 'UserError' ? e.message : 'Something went wrong sending that. Try again in a minute.').catch(() => {}); if (e.name !== 'UserError') logger.warn(`Modmail DM: ${e.message}`); }
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (!i.guildId) {
        if (i.isStringSelectMenu?.() && i.customId === 'mmpick') {
          const msg = pendingDMs.get(i.user.id); pendingDMs.delete(i.user.id);
          const gid = i.values?.[0];
          if (!msg || !manager.isActive(gid, 'modmail')) return await i.update({ content: 'That expired. Send your message again.', components: [] }).catch(() => {});
          await i.update({ content: `Sending it to the staff of **${client.guilds.cache.get(gid)?.name ?? 'that server'}**...`, components: [] }).catch(() => {});
          await manager.ctx(gid, 'modmail').api('modmail').fromDM(gid, msg).catch((e) => i.followUp({ content: e.message }).catch(() => {}));
          return;
        }
        if (i.isButton?.() && i.customId.startsWith('rate:')) { // 3.1 ticket ratings, sent by DM
          const [, gid, number, stars] = i.customId.split(':');
          if (!manager.isActive(gid, 'support')) return await i.update({ content: 'Tickets are off in that server now.', embeds: [], components: [] }).catch(() => {});
          const text = await Promise.resolve().then(() => manager.ctx(gid, 'support').api('support').rate(gid, number, i.user.id, stars)).catch((e) => (e.name === 'UserError' ? e.message : 'Something went wrong. Try again later.'));
          return await i.update({ content: text, components: [] }).catch(() => {});
        }
        if (i.isRepliable()) await i.reply({ content: 'This bot only works inside servers.', flags: 64 }).catch(() => {});
        return;
      }
      if (i.isAutocomplete()) return await manager.handleAutocomplete(i);
      if (i.isChatInputCommand() || i.isContextMenuCommand()) return await manager.handleCommand(i);
      if (i.isMessageComponent() || i.isModalSubmit()) return await manager.handleComponent(i);
    } catch (e) { logger.error(`Interaction error: ${e.stack ?? e.message}`); }
  });

  for (const [eventName, resolve] of Object.entries(EVENT_GUILD)) {
    client.on(eventName, async (...args) => {
      try {
        if (eventName.startsWith('messageReaction')) {
          const [reaction, user] = args;
          if (reaction.partial) await reaction.fetch();
          if (reaction.message.partial) await reaction.message.fetch();
          if (user.partial) await user.fetch();
        }
        const guildId = resolve(...args);
        if (eventName === 'messageCreate' && guildId && !args[0]?.author?.bot && !args[0]?.webhookId) statHistory.count(guildId);
        if (guildId) await manager.dispatch(eventName, guildId, ...args);
      } catch (e) { logger.warn(`Event ${eventName} dropped: ${e.message}`); }
    });
  }

  client.on(Events.Error, (e) => logger.error(`Discord client error: ${e.message}`));
}

/** Keeps a "Good Boy vX · Basic Ghost Labs" line at the end of the bot's Discord description; the owner's own text is left alone.
 *  Every copy keeps this credit, white-label ones included. */
async function syncDescription(app) {
  try {
    const next = withVersionLine(app.description, version);
    if (next !== (app.description ?? '')) { await app.edit({ description: next }); logger.info(`Bot description now ends with the version line (v${version}).`); }
  } catch (e) { logger.warn(`Could not update the bot description: ${e.message}`); }
}

async function onReady(client) {
  logger.info(`Logged in as ${client.user.tag} - in ${client.guilds.cache.size} server(s)`);

  try {
    const app = await client.application.fetch();
    await syncDescription(app);
    syncEmojis(client.application, { log: (m) => logger.warn(m) })
      .then((r) => { if (r.added || r.removed || r.failed) logger.info(`Animated emojis: ${r.added} added, ${r.removed} old removed, ${r.kept} kept${r.failed ? `, ${r.failed} failed` : ''}.`); })
      .catch((e) => logger.warn(`Animated emojis could not be set up: ${e.message}. Normal emojis are used instead.`));
    const o = app.owner;
    if (o?.members) { manager.ownerIds.add(o.ownerId); for (const id of o.members.keys()) manager.ownerIds.add(id); }
    else if (o?.id) manager.ownerIds.add(o.id);
  } catch (e) { logger.warn(`Could not read application owner: ${e.message}`); }

  for (const [, guild] of client.guilds.cache) {
    try {
      db.upsertGuild(guild.id, guild.name);
      await manager.restoreGuild(guild.id);
      await manager.syncCommands(guild.id);
      await sleep(200);
    } catch (e) { logger.error(`Startup for "${guild.name}" failed: ${e.message}`); }
  }

  manager.startTasks();
  // Sparkline history: a sample every 10 minutes into this hour's row (kept 14 days).
  const sample = () => { try { statHistory.sampleAll(client); } catch (e) { logger.warn(`Stats history: ${e.message}`); } };
  sample();
  setInterval(sample, 600000).unref?.();
  const missing = ['MessageContent', 'GuildMembers', 'GuildPresences'].filter((n) => !manager.intents.has(n));
  if (missing.length) {
    logger.warn(`Running without privileged intent(s): ${missing.join(', ')}. Some features are reduced. ` +
      'Enable them at https://discord.com/developers/applications > your app > Bot > Privileged Gateway Intents, then restart.');
  }
  logger.info('Ready. In Discord, run /module list to turn features on.');
  link?.ready();
}

async function login() {
  await manager.discover(path.join(root, 'modules'));
  if (extraModules) await manager.discover(extraModules);
  logger.info(`Loaded ${manager.defs.size} module(s): ${[...manager.defs.keys()].join(', ') || 'none'}`);

  for (const priv of ATTEMPTS) {
    const names = [...BASE, ...priv];
    const client = new Client({
      intents: names.map((n) => GatewayIntentBits[n]),
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
      allowedMentions: { parse: [], repliedUser: false }, // modules opt in to pings explicitly
    });
    manager.attach(client, names);
    wire(client);
    try {
      await client.login(token);
      return client;
    } catch (err) {
      client.destroy();
      if (/disallowed intents/i.test(err.message) || err.code === 'DisallowedIntents') {
        logger.warn(`Discord rejected privileged intents (${priv.join(', ') || 'none'}). Retrying with fewer...`);
        continue;
      }
      if (/invalid token|TokenInvalid/i.test(err.message) || err.code === 'TokenInvalid') {
        logger.error('Discord says your bot token is invalid. Check DISCORD_TOKEN in .env (reset it in the Developer Portal if unsure).');
      } else logger.error(`Login failed: ${err.message}`);
      process.exit(1);
    }
  }
  logger.error('Could not log in with any intent set.');
  process.exit(1);
}

const client = await login();
// The Good Boy hub (3.0): lets other people's Good Boy bots show this bot's servers in their switcher, and the other way round.
let dashboardRef = null;
const hub = hubUrl() && client.application ? new Hub({ base: hubUrl(), dataDir, app: client.application, url: () => dashboardRef?.baseUrl?.(), guilds: () => [...client.guilds.cache.keys()], log: (m) => logger.warn(m) }) : null;
const dashboard = await startDashboard({ manager, client, db, logger, perms, version, dataDir, updates: link, hub, statHistory }).catch((e) => { logger.warn(`Dashboard not started: ${e.message}`); return null; });
dashboardRef = dashboard;
if (hub) {
  const joinHub = () => hub.register().then((r) => { if (r.ok) logger.info('Joined the Good Boy hub.'); else if (r.skipped) logger.info(`Good Boy hub: skipped (${r.skipped}).`); }).catch((e) => logger.warn(`Good Boy hub: ${e.message}`));
  setTimeout(joinHub, 60000).unref?.();
  setInterval(joinHub, 6 * 3600000).unref?.();
} else if (String(process.env.GOODBOY_HUB ?? '').toLowerCase() === 'off' && process.env.GOODBOY_HUB_URL && client.application) {
  new Hub({ base: String(process.env.GOODBOY_HUB_URL).replace(/\/+$/, ''), dataDir, app: client.application, url: () => null, guilds: () => [] }).leave().catch(() => {});
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received - shutting down cleanly`);
  try { statHistory.sampleAll(client); } catch { /* ignore */ }
  try { dashboard?.close(); await manager.shutdown(); await client.destroy(); db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error(`Unhandled rejection: ${e?.stack ?? e}`));
process.on('uncaughtException', (e) => logger.error(`Uncaught exception: ${e?.stack ?? e}`));
