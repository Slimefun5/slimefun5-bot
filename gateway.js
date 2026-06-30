// Slimefun5 bot — Node gateway entry (run on a VM for ALL features).
//
// Two parts:
//   1. A discord.js gateway client — the VM-only features: live message filters / auto-replies.
//   2. A small HTTP server (health + /report + /interactions) that the Cloudflare Worker forwards to
//      when this VM is up, so reports and commands flow through here instead of Cloudflare.
//
// Env: DISCORD_BOT_TOKEN (required), DISCORD_WEBHOOK_URL (#bug-reports), GITHUB_OWNER (optional),
//      PORT (Koyeb/Fly set this), RELAY_KEY (optional shared secret matching the Worker).

import http from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commandDefinitions, handleInteraction, postReportTo } from './src/commands.js';

const env = { GITHUB_OWNER: process.env.GITHUB_OWNER || 'Slimefun5' };
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const relayKey = process.env.RELAY_KEY;
const PORT = process.env.PORT || 8080;

const SLIMEFUN = /Slime(?:F|( f))un/;
const INVITE = /discord\.gg\/([A-Za-z0-9]+)/i;
const OUR_INVITE = 'cbbyzbewdr';

// 1) Gateway client — message filters / auto-replies (need a persistent connection).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Slimefun5 bot online as ${c.user.tag}`);
  try {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (guildId) {
      const guild = await c.guilds.fetch(guildId);
      await guild.commands.set(commandDefinitions());
      console.log('Registered guild slash commands');
    } else {
      await c.application.commands.set(commandDefinitions());
      console.log('Registered global slash commands');
    }
  } catch (e) {
    console.error('command registration failed', e);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const invite = message.content.match(INVITE);
  if (invite && invite[1].toLowerCase() !== OUR_INVITE) {
    await message.delete().catch(() => {});
    await message.channel.send(`${message.author}, please don't post other server invites here.`).catch(() => {});
    return;
  }

  const match = SLIMEFUN.exec(message.content);
  if (match && match[0] !== 'Slimefun') {
    await message.reply(`It's Slimefun, not ${match[0]} 🙂`).catch(() => {});
  }
});

client.on(Events.Error, (e) => console.error('Discord client error:', e?.message || e));

// The gateway is best-effort: if it can't connect (e.g. the Message Content Intent isn't enabled in
// the Developer Portal), keep the HTTP relay below alive so reports/commands still work. The message
// filters need that intent, so enable it to turn them on.
process.on('uncaughtException', (e) => console.error('uncaughtException (continuing):', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection (continuing):', e?.message || e));

client.login(process.env.DISCORD_BOT_TOKEN).catch((e) =>
  console.error('Gateway login failed — message filters are off until the Message Content Intent is enabled.', e?.message || e)
);

// 2) HTTP server — what the Worker forwards to (and the host's health check).
const postReport = (report) => postReportTo(webhookUrl, report);

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (relayKey && req.headers['x-relay-key'] !== relayKey) {
    res.writeHead(401);
    res.end();
    return;
  }

  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', async () => {
    try {
      const body = JSON.parse(data || '{}');

      if (req.url === '/report') {
        const meta = `**Player:** ${body.player || 'unknown'}  **Slimefun:** ${body.sfVersion || '?'}  **MC:** ${body.mcVersion || '?'}`;
        const ok = await postReport({ title: body.title, description: body.description, plugins: body.plugins, meta });
        send(res, ok ? 200 : 502, { ok });
      } else if (req.url === '/interactions') {
        const response = await handleInteraction(body, { env, postReport });
        send(res, 200, response);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (e) {
      console.error('http handler failed', e);
      res.writeHead(500);
      res.end();
    }
  });
}).listen(PORT, () => console.log(`HTTP server on :${PORT}`));

function send (res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
