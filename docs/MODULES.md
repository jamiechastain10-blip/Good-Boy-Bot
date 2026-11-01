# Writing modules and add-ons

A module is a folder in `modules/` containing an `index.js` with a default export. The folder name **must equal** the module's `name`
(lowercase letters, numbers, dashes). On startup the core loads every folder; a module that fails validation is skipped with a clear message and never stops the bot.

```js
import { SlashCommandBuilder } from 'discord.js';

export default {
  name: 'hello',                      // = folder name
  version: '1.0.0',                   // semver
  description: 'Says hello.',
  settings: [                         // drives /config AND the dashboard form
    { key: 'greeting', type: 'text', label: 'Greeting', default: 'Hello' },
  ],
  permissions: [                      // keys MUST start with "<name>."
    { key: 'hello.use', label: 'Use /hello', default: 'everyone' },   // everyone | moderator | admin | owner
  ],
  commands: [{
    permission: 'hello.use',          // checked centrally BEFORE execute runs
    data: new SlashCommandBuilder().setName('hello').setDescription('Say hello'),
    async execute(ctx, interaction) {
      await interaction.reply(ctx.config.get('greeting'));
    },
  }],
  events: { guildMemberAdd: async (ctx, member) => { /* ... */ } },
  components: [{ prefix: 'hello:', execute: async (ctx, interaction) => { /* buttons, selects, modals */ } }],
  tasks: [{ name: 'tick', everyMs: 60000, run: async (ctx) => { /* runs per enabled server */ } }],
  api: { /* functions other modules/add-ons may call via ctx.api('hello') */ },
  migrations: [{ id: 1, sql: 'CREATE TABLE hello_log (id INTEGER PRIMARY KEY, who TEXT)' }],   // tables must start with "<name>_"
  views: { async stats(ctx, query) { return { rows: [] }; } },                   // data for a dashboard panel
  actions: { async 'do-thing'(ctx, body, actor) { /* body.id / body.userId, actor = who clicked */ } },
  panels: [{ id: 'stats', title: 'Stats', view: 'stats', permission: 'hello.use',   // permission = who may see it without Manage Server
    columns: [{ key: 'name', label: 'Name' }], rowActions: [{ action: 'do-thing', label: 'Do it' }] }],
  async init(ctx) {},                 // server enabled (also on every bot start)
  async destroy(ctx) {},              // server disabled / bot stopping
  async update(ctx, fromVersion) {},  // saved version is older than this one
};
```

## The `ctx` object (always scoped to ONE server)
| | |
|---|---|
| `ctx.guildId`, `ctx.guild`, `ctx.client` | the server (`guild` may be null if the bot was removed) |
| `ctx.config.get(key, fallback)` / `.set` / `.all` | the module's settings for this server (defaults come from `settings`) |
| `ctx.data.get/set/delete/list(prefix)/update(key, fn, fallback)/deletePrefix` | private key-value storage; a module can only reach **its own** rows, per server. `update` is atomic |
| `ctx.perms.check(member, key)`, `.rolesFor(key)`, `.isAdmin`, `.isModerator` | permission helpers |
| `ctx.queue(fn, {priority})` | run Discord calls through the fairness queue (per-module cap) |
| `ctx.log.info/warn/error`, `ctx.security(msg)` | logging (warn/error/security are kept for the dashboard) |
| `ctx.api(name)`, `ctx.isActive(name)`, `ctx.hostApi` | talk to other modules / an add-on's host |
| `ctx.hasIntent('MessageContent')` | whether a privileged intent is actually active |
| `ctx.sql.run/get/all/transaction` | SQL on your own `<name>_` tables (declared in `migrations`) |
| `ctx.settings.set(key, value, op)` | change a setting through the same validated path `/config` and the dashboard use |
| `ctx.notify.allowed(userId, category)` | respect a member's notification preferences before DMing or pinging |

## Settings types
`toggle`, `text` (`maxLength`), `number` (`min`, `max`), `channel`, `role`, `select` (`options`), `list` (strings). Values are validated by the core, so a module can trust them.

## Events a module may use
`guildMemberAdd, guildMemberRemove, messageCreate, messageDelete, messageUpdate, messageReactionAdd, messageReactionRemove,
presenceUpdate, voiceStateUpdate, channelDelete, roleDelete, guildBanAdd, guildAuditLogEntryCreate`. Handlers get `(ctx, ...discordArgs)` and only fire for servers where the module is enabled.

## Popups (modals) and half-finished commands (2.1 style)
Discord allows a popup only as the *first* response to an interaction, with at most 5 text fields, and not in answer to another popup. `src/forms.js` gives a small store for this: the command saves its simple options with `formStore('mymodule').put({ by: user.id, ... })`, shows the popup with the returned token in its `customId`, and the popup's submit handler calls `.take(token, user.id)` (single use, owner only, expires after 15 minutes). Because validation errors can't re-open a popup, check the cheap things *before* showing it.

## Every command is a popup (2.2)
Write commands with normal slash options (`addStringOption`, `addUserOption`, ...). The core registers them with Discord **without** those options and, when the command runs, opens a popup built from them; your `execute` then reads `i.options.getString(...)` etc. as usual. More than 5 options are asked in parts automatically. If your command shows its own, richer popup when run with nothing filled in, declare `ownPopup: ['subcommand']` (or `ownPopup: true`) and the core leaves it alone. Don't call `showModal` after reading options: Discord does not allow a popup in answer to a popup.

## The modal pipeline (2.2): command -> button -> popup
New commands should take **no typed options**. Anything typed goes in a popup, opened from a private button:

```js
import { createPipeline } from '../../src/modalpipe.js';

const pipe = createPipeline({
  ns: 'mph',                                  // short prefix, unique across modules
  forms: {
    greet: {
      title: 'Send a greeting', permission: 'hello.use',
      button: { label: 'Configure greeting', emoji: '👋' },
      intro: 'Pick who to greet and what to say.',
      precheck: async (ctx, i, args) => {},   // cheap checks, before the button AND before the popup
      fields: (ctx, i, [targetId]) => [      // built when the popup opens; see src/modalkit.js for kinds
        ...(targetId ? [] : [{ id: 'who', kind: 'user', label: 'Who' }]),
        { id: 'text', kind: 'paragraph', label: 'Message', max: 500 },
      ],
      async submit(ctx, i, values, [targetId]) {
        // throw new UserError('...') -> the member sees it with a "Try again" button that reopens the form pre-filled
        await i.reply({ content: `👋 <@${targetId ?? values.who}> ${values.text}` });
      },
    },
  },
});

// in the module definition
commands: [
  { permission: 'hello.use', data: new SlashCommandBuilder().setName('greet').setDescription('Greet someone'), execute: (ctx, i) => pipe.launch(ctx, i, 'greet') },
  { permission: 'hello.use', data: new ContextMenuCommandBuilder().setName('Greet').setType(ApplicationCommandType.User), execute: (ctx, i) => pipe.launch(ctx, i, 'greet', [i.targetUser.id]) },
],
components: [pipe.component],
```

- `pipe.launch(ctx, i, form, args)`: from a command, posts the private button. `args` (ids, short words) travel in the signed token.
- `pipe.open(ctx, i, form, args)`: opens the popup straight from a click on your own button or select.
- `pipe.button(i, form, args, { label, emoji })`: a button for your own messages that opens a form.
- Field kinds: `text`, `paragraph`, `number`, `select` (`options`, `value`), `user`, `role`, `roles`, `channel`. 5 fields at most, labels 45 characters at most (checked when the form is built).
- Tokens are signed, owner-locked, expire after 15 minutes, can be submitted once, and survive hot reloads and restarts. Details: `docs/GAMES.md` section 0.
- Set `trigger: 'direct'` on a form (or the pipeline) to skip the button. Discord allows a popup straight from a command.

## Dashboard panels
A panel is a table (`view`) with optional row actions and confirmed global actions. The server only lets a person without Manage Server use a panel if they hold the dashboard-wide `dashboard.access` permission **and** the panel's own `permission`; a panel without a `permission` is admin-only. Row actions are sent `{ id, userId }` (both set to the row's `id`); read whichever suits.

## Keeping logic testable
A module file is reloaded as a separate copy each time it is enabled or reloaded, but files it imports are not. Put rules that need no Discord objects in `src/` as plain functions (`src/tickets.js`, `src/automod.js`, `src/gif.js`) and test them directly. State that must survive a reload or be shared with tests goes on `globalThis[Symbol.for('goodboy.<module>.<thing>')]`.

## Add-ons
```js
export default {
  name: 'support-html-transcripts', version: '1.0.0',
  type: 'addon',
  requires: { module: 'support', version: '>=1.0.0' },    // semver range
  async init(ctx) { ctx.hostApi.registerTranscriptFormat('html', fn, 'support-html-transcripts'); },
};
```
The core refuses to enable an add-on unless its host is installed, version-compatible **and enabled in that server**, and refuses to disable a host while an add-on depends on it (unless you cascade). A module can also list `dependencies: [{ module, version }]`.

## Rules the validator enforces (so mistakes show up at load time, not in Discord)
Unique command names across modules; commands can't mix subcommands with plain options; required options before optional ones; descriptions 1–100 chars; permission keys prefixed with the module name; commands can only reference permissions the module declares; unknown event names are rejected.

## Guidelines
- Defer slow work: `await interaction.deferReply({ flags: MessageFlags.Ephemeral })` (Discord gives 3 seconds to respond).
- Throw `UserError` (from `src/util.js`) for problems the user should see; any other error is logged, counted against the module's health, and the user gets a generic message. Internal error text is never shown to users.
- Keep pings off: the bot's default `allowedMentions` is "none". Opt in per message only where needed.
- Never trust Discord-supplied text in a role name, channel name, or regex without sanitising/escaping.
- Modules are **trusted code** running in the bot's process. Review anything you install.

## Developing
- `/module` → pick the module → **Reload from disk** (bot owner) hot-reloads your code in every server using it. If it fails to load or start, it rolls back to the previous version automatically, and a database backup is taken first.
- `npm test` loads every module with the real discord.js and validates it. Add a test in `tests/run.js` using the fake-Discord helpers there.
