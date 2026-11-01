/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Helpers for driving the 2.2 modal pipeline (src/modalpipe.js) with fake interactions:
 * command -> private button -> popup -> submit.
 */
const json = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);

/** Every customId on a message payload (buttons and selects), in order. */
export function customIds(payload) {
  const out = [];
  for (const row of payload?.components ?? []) for (const c of json(row).components ?? []) if (c.custom_id) out.push(c.custom_id);
  return out;
}
export const firstButtonId = (payload) => customIds(payload)[0];

/** The popup's customId and its field ids (labels in the newer popups wrap one component each). */
export function modalInfo(modal) {
  const j = json(modal);
  const fields = (j.components ?? []).map((c) => c.component?.custom_id ?? c.components?.[0]?.custom_id).filter(Boolean);
  const labels = (j.components ?? []).map((c) => c.label).filter(Boolean);
  return { customId: j.custom_id, title: j.title, fields, labels };
}

/**
 * A `fields` object like discord.js gives a popup submit. values: { id: 'text' | ['select', 'values'] }.
 * Picker values (user/role/channel) are given as arrays of ids.
 */
export function fakeFields(values) {
  const coll = (ids = []) => { const m = new Map(ids.map((id) => [id, { id }])); return m; };
  const arr = (id) => [].concat(values[id] ?? []);
  return {
    getTextInputValue: (id) => { if (!(id in values)) throw new Error(`no text field ${id}`); return String(values[id]); },
    getStringSelectValues: (id) => arr(id),
    getSelectedUsers: (id) => coll(arr(id)),
    getSelectedRoles: (id) => coll(arr(id)),
    getSelectedChannels: (id) => coll(arr(id)),
  };
}
