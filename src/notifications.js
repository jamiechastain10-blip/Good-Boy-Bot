/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Central notification-preference service. EVERY module that pings, DMs or announces to a
 * member must ask `ctx.notify.allowed(userId, category)` first, so no feature can bypass an opt-out.
 * Resolution order: the member's own choice, then the server default, then the category default.
 */
export const CATEGORIES = {
  'game-pings': { label: 'Game pings (LFG and game role pings)', default: true },
  'party-invites': { label: 'Party invitations', default: true },
  achievements: { label: 'Achievement announcements', default: true },
  recaps: { label: 'Weekly / monthly activity recaps', default: false },
  'event-reminders': { label: 'Event reminders', default: true },
  minecraft: { label: 'Minecraft notifications', default: true },
  dms: { label: 'Direct messages from the bot', default: true },
};

export class Notifications {
  constructor(db) { this.db = db; }

  allowed(guildId, userId, category) {
    if (!(category in CATEGORIES)) return false; // unknown categories are never allowed
    const own = this.db.getNotifyPref(guildId, userId, category);
    if (own !== undefined) return own;
    const server = this.db.getNotifyPref(guildId, '*', category);
    if (server !== undefined) return server;
    return CATEGORIES[category].default;
  }

  filter(guildId, userIds, category) { return userIds.filter((id) => this.allowed(guildId, id, category)); }

  effective(guildId, userId) {
    return Object.keys(CATEGORIES).map((category) => ({ category, enabled: this.allowed(guildId, userId, category),
      source: this.db.getNotifyPref(guildId, userId, category) !== undefined ? 'you' : this.db.getNotifyPref(guildId, '*', category) !== undefined ? 'server' : 'default' }));
  }
}
