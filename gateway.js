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
import { Client, Events, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { commandDefinitions, handleInteraction, postReportTo } from './src/commands.js';

const env = { GITHUB_OWNER: process.env.GITHUB_OWNER || 'Slimefun5' };
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const relayKey = process.env.RELAY_KEY;
const workerUrl = process.env.WORKER_URL;
const helpfulRoleId = process.env.HELPFUL_ROLE_ID || '1520847896637997148';
const PORT = process.env.PORT || 8080;

const SLIMEFUN = /[Ss]lime(?:F|( [Ff]))un/;
const INVITE = /discord(?:app\.com\/invite|\.gg)\/([A-Za-z0-9]+)/i;
const OUR_INVITE = 'cbbyzbewdr';
// A `!` or `?` prefixed command/tag, e.g. "?rp", "?1.21" or "!warn add @user spam".
const PREFIX = /^[!?]([a-z0-9_.-]+)(?:\s+([\s\S]+))?$/;
// Commands relayed to the Worker (which owns KV + the report webhook). helpful/help are handled here.
const RELAY_COMMANDS = new Set(['ping', 'version', 'wiki', 'addon', 'report', 'tag', 'warn', 'commands']);

const SCAM_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TIMEOUT_MS = 60 * 60 * 1000;

// Scam-link domains, refreshed from public block-lists on startup.
const scamDomains = new Set();
const SCAM_LISTS = [
  'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.txt',
  'https://raw.githubusercontent.com/BuildBot42/discord-scam-links/main/list.txt'
];

async function loadScamDomains () {
  for (const url of SCAM_LISTS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      for (const line of (await res.text()).split('\n')) {
        const domain = line.trim().toLowerCase();
        if (domain && !domain.startsWith('#')) scamDomains.add(domain);
      }
    } catch (e) {
      console.error('Scam list load failed:', url, e?.message || e);
    }
  }
  console.log(`Loaded ${scamDomains.size} scam domains`);
}

loadScamDomains();

async function timeoutMember (member, ms, reason) {
  if (!member) return;
  try { await member.timeout(ms, reason); } catch { /* missing perms or higher role */ }
}

/** Toggles the Helpful role on a member. Resolved by HELPFUL_ROLE_ID, else by name (exact, then contains). */
async function toggleHelpful (member) {
  if (!member) return "I couldn't find your server membership.";
  const roles = member.guild.roles.cache;
  const wanted = (process.env.HELPFUL_ROLE_NAME || 'helpful').toLowerCase();
  const role = (helpfulRoleId && roles.get(helpfulRoleId))
    || roles.find((r) => r.name.toLowerCase() === wanted)
    || roles.find((r) => r.name.toLowerCase().includes('helpful'));
  if (!role) {
    return 'I couldn\'t find the Helpful role. Set HELPFUL_ROLE_ID (or HELPFUL_ROLE_NAME) so I can find it.';
  }
  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      return 'Removed the **Helpful** role — thanks for all your help! 👋';
    }
    await member.roles.add(role);
    return 'You now have the **Helpful** role — thanks for helping out! 🙌';
  } catch {
    return "I couldn't change your roles — I may be missing Manage Roles, or my role is below the Helpful role.";
  }
}

function parseUserId (token) {
  const match = (token || '').match(/\d{15,}/);
  return match ? match[0] : '';
}

/** Parses a prefix command's argument string into the {subcommand, options} the shared command expects. */
function parsePrefixArgs (name, rest) {
  const tokens = rest ? rest.split(/\s+/) : [];
  if (name === 'wiki') return { options: { term: rest } };
  if (name === 'addon') return { options: { name: rest } };
  if (name === 'report') {
    const [title, description, plugin] = rest.split('|').map((s) => s.trim());
    return { options: { title: title || rest, description: description || '', plugin: plugin || '' } };
  }
  if (name === 'tag') {
    const sub = (tokens[0] || 'list').toLowerCase();
    if (sub === 'list') return { subcommand: 'list', options: {} };
    if (sub === 'create') return { subcommand: 'create', options: { name: tokens[1] || '', content: tokens.slice(2).join(' ') } };
    if (sub === 'alias') return { subcommand: 'alias', options: { name: tokens[1] || '', target: tokens[2] || '' } };
    if (sub === 'get' || sub === 'delete') return { subcommand: sub, options: { name: tokens[1] || '' } };
    return { subcommand: 'get', options: { name: tokens[0] || '' } };
  }
  if (name === 'warn') {
    const sub = (tokens[0] || 'list').toLowerCase();
    if (sub === 'add') return { subcommand: 'add', options: { user: parseUserId(tokens[1]), reason: tokens.slice(2).join(' ') } };
    if (sub === 'list' || sub === 'clear') return { subcommand: sub, options: { user: parseUserId(tokens[1]) } };
    return { subcommand: 'list', options: { user: parseUserId(tokens[0]) } };
  }
  return { options: {} };
}

/** POSTs JSON to the Worker (with the relay key) and returns its `content` field, or null. */
async function callWorker (path, payload) {
  if (!workerUrl) return null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (relayKey) headers['X-Relay-Key'] = relayKey;
    const res = await fetch(workerUrl.replace(/\/$/, '') + path, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) return null;
    return (await res.json()).content || null;
  } catch { return null; }
}

/** Runs a prefix command by relaying it to the Worker's /command endpoint, then replies with the result. */
async function runPrefixCommand (message, name, rest) {
  const parsed = parsePrefixArgs(name, rest);
  const perms = message.member?.permissions;
  const isStaff = !!perms && (
    perms.has(PermissionsBitField.Flags.Administrator) ||
    perms.has(PermissionsBitField.Flags.ManageMessages) ||
    perms.has(PermissionsBitField.Flags.ModerateMembers)
  );
  const resolvedUsers = {};
  if (parsed.options?.user) {
    const mentioned = message.mentions?.users?.get(parsed.options.user);
    resolvedUsers[parsed.options.user] = { username: mentioned ? mentioned.username : parsed.options.user };
  }
  const content = await callWorker('/command', {
    name,
    subcommand: parsed.subcommand || null,
    options: parsed.options || {},
    resolvedUsers,
    author: message.author.username,
    isStaff
  });
  if (content) await message.reply(String(content).slice(0, 2000)).catch(() => {});
}

/** Replies with a tag's content (or the full list for help/tags), fetched from the Worker's KV. */
async function replyTag (message, name) {
  if (!workerUrl) return;
  const endpoint = (name === 'help' || name === 'tags') ? '/tags' : `/tag?name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}${endpoint}`);
    if (res.ok) {
      const data = await res.json();
      if (data.content) await message.reply(data.content).catch(() => {});
    }
  } catch { /* worker unreachable — ignore */ }
}

// 1) Gateway client — message filters / auto-replies (need a persistent connection).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Gateway connected as ${c.user.tag} — message filters active`);
  // Register to the connected guild(s) — instant, unlike global commands which take up to ~1h.
  await registerCommands([...c.guilds.cache.keys()]);
});

// Registers slash commands. With guild IDs: instant per-guild (and clears the global set to avoid
// duplicates). With none (gateway couldn't connect): falls back to a global registration.
async function registerCommands (guildIds) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;

  try {
    const me = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token}` } });
    if (!me.ok) { console.error('App lookup failed:', me.status, await me.text()); return; }
    const appId = (await me.json()).id;
    const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify(commandDefinitions());
    const api = 'https://discord.com/api/v10/applications/' + appId;

    if (guildIds && guildIds.length) {
      await fetch(`${api}/commands`, { method: 'PUT', headers, body: '[]' }); // clear global (dedupe)
      for (const guildId of guildIds) {
        const res = await fetch(`${api}/guilds/${guildId}/commands`, { method: 'PUT', headers, body });
        if (!res.ok) console.error(`Guild ${guildId} registration failed: ${res.status} ${await res.text()}`);
      }
      console.log(`Registered ${commandDefinitions().length} commands to ${guildIds.length} guild(s) (instant)`);
    } else {
      const res = await fetch(`${api}/commands`, { method: 'PUT', headers, body });
      console.log(res.ok ? 'Registered global commands (up to ~1h to appear)' : `Global registration failed: ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error('Command registration error:', e?.message || e);
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content;

  // Moderators are exempt from the removal filters.
  const isStaff = message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages) ?? false;

  if (!isStaff) {
    const lower = content.toLowerCase();
    if (scamDomains.size && [...scamDomains].some((domain) => lower.includes(domain))) {
      await message.delete().catch(() => {});
      await timeoutMember(message.member, SCAM_TIMEOUT_MS, 'Scam link');
      await message.channel.send(`${message.author}, that looked like a scam link — it was removed.`).catch(() => {});
      return;
    }

    const invite = content.match(INVITE);
    if (invite && invite[1].toLowerCase() !== OUR_INVITE) {
      await message.delete().catch(() => {});
      await timeoutMember(message.member, INVITE_TIMEOUT_MS, 'Invite link');
      await message.channel.send(`${message.author}, please don't post other server invites here.`).catch(() => {});
      return;
    }
  }

  const match = SLIMEFUN.exec(content);
  if (match && match[0] !== 'Slimefun') {
    await message.reply(`It's Slimefun, not ${match[0]} 🙂`).catch(() => {});
    return;
  }

  // `!`/`?` prefixed messages → a command (relayed to the Worker), the Helpful-role toggle, or a tag.
  const prefixed = content.trim().match(PREFIX);
  if (!prefixed) return;
  const name = prefixed[1].toLowerCase();
  const rest = (prefixed[2] || '').trim();

  if (name === 'helpful') {
    await message.reply(await toggleHelpful(message.member)).catch(() => {});
  } else if (RELAY_COMMANDS.has(name)) {
    await runPrefixCommand(message, name, rest);
  } else {
    await replyTag(message, name); // tags, plus help/tags list
  }
});

client.on(Events.Error, (e) => console.error('Discord client error:', e?.message || e));

// The gateway is best-effort: if it can't connect (e.g. the Message Content Intent isn't enabled in
// the Developer Portal), keep the HTTP relay below alive so reports/commands still work. The message
// filters need that intent, so enable it to turn them on.
process.on('uncaughtException', (e) => console.error('uncaughtException (continuing):', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection (continuing):', e?.message || e));

client.login(process.env.DISCORD_BOT_TOKEN).catch((e) => {
  console.error('Gateway login failed — message filters are off until the Message Content Intent is enabled.', e?.message || e);
  registerCommands(); // no guild context → global registration so slash commands still work
});

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
      } else if (req.url === '/helpful') {
        const guild = (body.guildId && client.guilds.cache.get(body.guildId)) || client.guilds.cache.first();
        const member = guild ? await guild.members.fetch(body.userId).catch(() => null) : null;
        send(res, 200, { content: await toggleHelpful(member) });
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
