/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * One way to build the newer Discord popups (a label above each field, with dropdowns and channel/role pickers) and to
 * read them back. A popup holds at most 5 fields and each label is at most 45 characters; both are checked here so a
 * bad form fails in tests, not in Discord.
 *
 * Field kinds: text, paragraph, number, channel, role, roles, user, select (single choice), files (uploads).
 */
import {
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  UserSelectMenuBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType, FileUploadBuilder,
} from 'discord.js';
import { UserError } from './util.js';

export const MAX_FIELDS = 5, MAX_LABEL = 45;

export function checkSpec(fields) {
  if (!fields.length || fields.length > MAX_FIELDS) throw new Error(`A popup holds 1 to ${MAX_FIELDS} fields (got ${fields.length}).`);
  for (const f of fields) {
    if (!f.id || !f.label) throw new Error('Each field needs an id and a label.');
    if (f.label.length > MAX_LABEL) throw new Error(`Label "${f.label}" is longer than ${MAX_LABEL} characters.`);
    if (f.desc && f.desc.length > 100) throw new Error(`The help under "${f.label}" is longer than 100 characters.`);
    if (f.kind === 'select' && !(f.options?.length >= 1 && f.options.length <= 25)) throw new Error(`"${f.label}" needs 1 to 25 choices.`);
  }
  return fields;
}

function component(f) {
  const req = f.required !== false;
  switch (f.kind ?? 'text') {
    case 'text': case 'number': case 'paragraph': {
      const t = new TextInputBuilder().setCustomId(f.id).setStyle(f.kind === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(req);
      if (f.max) t.setMaxLength(f.max);
      if (f.placeholder) t.setPlaceholder(f.placeholder);
      if (f.value != null && f.value !== '') t.setValue(String(f.value).slice(0, f.max ?? 4000));
      return ['setTextInputComponent', t];
    }
    case 'channel': {
      const c = new ChannelSelectMenuBuilder().setCustomId(f.id).setMinValues(req ? 1 : 0).setMaxValues(1).setRequired(req)
        .setChannelTypes(...(f.channelTypes ?? [ChannelType.GuildText, ChannelType.GuildAnnouncement]));
      if (f.placeholder) c.setPlaceholder(f.placeholder);
      if (f.value) c.setDefaultChannels(f.value);
      return ['setChannelSelectMenuComponent', c];
    }
    case 'role': case 'roles': {
      const r = new RoleSelectMenuBuilder().setCustomId(f.id).setMinValues(req ? 1 : 0).setMaxValues(f.kind === 'roles' ? (f.maxValues ?? 5) : 1).setRequired(req);
      if (f.placeholder) r.setPlaceholder(f.placeholder);
      if (f.value) r.setDefaultRoles(...[].concat(f.value)); // shows the current role, so saving without touching it keeps it
      return ['setRoleSelectMenuComponent', r];
    }
    case 'user': {
      const u = new UserSelectMenuBuilder().setCustomId(f.id).setMinValues(req ? 1 : 0).setMaxValues(f.maxValues ?? 1).setRequired(req);
      if (f.placeholder) u.setPlaceholder(f.placeholder);
      return ['setUserSelectMenuComponent', u];
    }
    case 'select': {
      const s = new StringSelectMenuBuilder().setCustomId(f.id).setMinValues(req ? 1 : 0).setMaxValues(1).setRequired(req)
        .addOptions(f.options.map((o) => { const b = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value); if (o.description) b.setDescription(o.description); if (o.value === f.value) b.setDefault(true); return b; }));
      return ['setStringSelectMenuComponent', s];
    }
    case 'files': {
      const u = new FileUploadBuilder().setCustomId(f.id).setMinValues(req ? 1 : 0).setMaxValues(f.maxValues ?? 10).setRequired(req);
      return ['setFileUploadComponent', u];
    }
    default: throw new Error(`Unknown field kind ${f.kind}`);
  }
}

/** Builds the popup. */
export function formModal(customId, title, fields) {
  checkSpec(fields);
  const labels = fields.map((f) => {
    const l = new LabelBuilder().setLabel(f.label);
    if (f.desc) l.setDescription(f.desc);
    const [setter, c] = component(f);
    return l[setter](c);
  });
  return new ModalBuilder().setCustomId(customId).setTitle(String(title).slice(0, 45)).addLabelComponents(...labels);
}

const first = (coll) => [...(coll?.values?.() ?? [])][0] ?? null;
const keysOf = (coll) => [...(coll?.keys?.() ?? [])];

/** Reads the answers back into plain values: text -> string, number -> number|null, channel/role/user -> id|null, roles -> [ids], select -> value|null. */
export function readForm(i, fields) {
  const out = {};
  for (const f of fields) {
    const kind = f.kind ?? 'text';
    if (kind === 'text' || kind === 'paragraph') out[f.id] = String(i.fields.getTextInputValue(f.id) ?? '').trim();
    else if (kind === 'number') {
      const raw = String(i.fields.getTextInputValue(f.id) ?? '').trim();
      if (!raw) out[f.id] = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new UserError(`${f.label} must be a number.`);
        if (f.min != null && n < f.min) throw new UserError(`${f.label} must be at least ${f.min}.`);
        if (f.maxNum != null && n > f.maxNum) throw new UserError(`${f.label} can be at most ${f.maxNum}.`);
        out[f.id] = Math.round(n);
      }
    } else if (kind === 'channel') out[f.id] = first(i.fields.getSelectedChannels(f.id, false))?.id ?? null;
    else if (kind === 'role') out[f.id] = keysOf(i.fields.getSelectedRoles(f.id, false))[0] ?? null;
    else if (kind === 'roles') out[f.id] = keysOf(i.fields.getSelectedRoles(f.id, false));
    else if (kind === 'user') out[f.id] = f.maxValues > 1 ? keysOf(i.fields.getSelectedUsers(f.id, false)) : keysOf(i.fields.getSelectedUsers(f.id, false))[0] ?? null;
    else if (kind === 'select') out[f.id] = (i.fields.getStringSelectValues(f.id) ?? [])[0] ?? null;
    else if (kind === 'files') {
      let files = null; try { files = i.fields.getUploadedFiles(f.id, false); } catch { files = null; }
      out[f.id] = [...(files?.values?.() ?? [])].map((a) => ({ name: String(a.name ?? 'file'), url: String(a.url ?? ''), size: a.size ?? 0, contentType: a.contentType ?? null }));
    }
  }
  return out;
}
