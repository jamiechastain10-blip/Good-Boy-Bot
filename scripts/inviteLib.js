/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
const BITS = { // permissions the bundled modules actually use (no Administrator needed)
  KickMembers: 1, BanMembers: 2, ManageChannels: 4, AddReactions: 6, ViewAuditLog: 7, ViewChannel: 10, SendMessages: 11, MentionEveryone: 17,
  ManageMessages: 13, EmbedLinks: 14, AttachFiles: 15, ReadMessageHistory: 16, Connect: 20, Speak: 21, ManageRoles: 28, ModerateMembers: 40,
};

/** A bot token's first segment is the base64 of the bot's user/application ID. */
export function clientIdFromToken(token) {
  try {
    const id = Buffer.from(String(token).split('.')[0], 'base64').toString('utf8');
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch { return null; }
}

export function inviteUrl(clientId) {
  const perms = Object.values(BITS).reduce((n, b) => n | (1n << BigInt(b)), 0n);
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=${encodeURIComponent('bot applications.commands')}&permissions=${perms}`;
}
