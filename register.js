// One-time slash-command registration. Run with the app's credentials set:
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... [DISCORD_GUILD_ID=...] node register.js
// A DISCORD_GUILD_ID registers instantly to that server (good for testing); without it, commands
// register globally (can take up to an hour to appear).

import { commandDefinitions } from './src/commands.js';

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN.');
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commandDefinitions())
});

console.log(`${res.status} ${res.statusText}`);
console.log(await res.text());
