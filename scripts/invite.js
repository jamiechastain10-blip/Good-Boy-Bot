/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Prints the link that adds the bot to a server. Run: npm run invite
 */
import { clientIdFromToken, inviteUrl } from './inviteLib.js';

const id = clientIdFromToken(process.env.DISCORD_TOKEN?.trim());
if (!id) { console.error('No valid DISCORD_TOKEN found in .env - run "npm run setup" first.'); process.exit(1); }
console.log('\nOpen this link to add the bot to a server you manage:\n\n' + inviteUrl(id) + '\n');
console.log("After adding it, drag the bot's role near the TOP of Server Settings > Roles,");
console.log("otherwise it can't manage roles, ban, or time out anyone above it.\n");
