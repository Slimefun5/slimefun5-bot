// Slimefun5 bot — Cloudflare Worker entry (no VM).
//
//   POST /report        in-game bug reports from the plugin (relayed to #bug-reports)
//   POST /interactions  Discord slash commands (HTTP Interactions; Ed25519-verified)
//
// Secrets (set in the Worker): DISCORD_WEBHOOK_URL (#bug-reports), DISCORD_PUBLIC_KEY (app public key).
// The Node gateway entry (gateway.js) reuses the same commands and adds message filters on a VM.

import { commands } from './src/commands.js';

const MAX_MESSAGE = 1800;
const MAX_FIELD = 80;

export default {
  async fetch (request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/report') {
      return handleReport(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/interactions') {
      return handleInteractions(request, env);
    }
    return json({ error: 'not_found' }, 404);
  }
};

async function handleReport (request, env) {
  if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'unconfigured' }, 503);

  if (env.REPORT_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.REPORT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const title = clean(body.title, 120);
  const description = clean(body.description, MAX_MESSAGE);
  const plugins = pluginList(body.plugins);

  if (!title && !description) return json({ error: 'empty_report' }, 400);

  const ok = await postReport(env, {
    title,
    description,
    plugins,
    meta: `**Player:** ${clean(body.player, MAX_FIELD) || 'unknown'}  **Slimefun:** ${clean(body.sfVersion, MAX_FIELD) || '?'}  **MC:** ${clean(body.mcVersion, MAX_FIELD) || '?'}`
  });

  return ok ? json({ ok: true }, 200) : json({ error: 'discord_failed' }, 502);
}

async function handleInteractions (request, env) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const raw = await request.text();

  if (!env.DISCORD_PUBLIC_KEY || !signature || !timestamp || !(await verify(raw, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
    return new Response('bad request signature', { status: 401 });
  }

  const interaction = JSON.parse(raw);

  if (interaction.type === 1) return json({ type: 1 });

  if (interaction.type === 2) {
    const command = commands[interaction.data.name];
    if (!command) return reply('Unknown command.');

    const options = {};
    for (const option of interaction.data.options || []) options[option.name] = option.value;
    const author = (interaction.member && interaction.member.user && interaction.member.user.username) || (interaction.user && interaction.user.username) || 'someone';

    const ctx = {
      env,
      getString: (name) => (options[name] != null ? String(options[name]) : ''),
      postReport: (report) => postReport(env, { ...report, meta: `**By:** ${author} (Discord)` })
    };

    const content = await command.run(ctx);
    return reply(content);
  }

  return reply('Unsupported interaction.');
}

async function postReport (env, report) {
  if (!env.DISCORD_WEBHOOK_URL) return false;

  const plugins = Array.isArray(report.plugins) ? report.plugins.join(', ') : (report.plugins || '(unspecified)');
  const content = `**Bug Report: ${report.title || '(no title)'}**\n`
    + `**Plugins:** ${plugins}\n`
    + (report.meta ? report.meta + '\n' : '')
    + '\n' + (report.description || '(no description)');

  const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } })
  });
  return resp.ok;
}

function pluginList (value) {
  if (Array.isArray(value)) return value.map((x) => clean(x, 40)).filter(Boolean).slice(0, 25);
  const single = clean(value, 200);
  return single ? [single] : [];
}

async function verify (body, signature, timestamp, publicKey) {
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hex (str) {
  const bytes = new Uint8Array(str.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(str.substr(i * 2, 2), 16);
  return bytes;
}

function clean (value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[`@]/g, '').trim().slice(0, max);
}

function reply (content) {
  return json({ type: 4, data: { content, allowed_mentions: { parse: [] } } });
}

function json (obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
