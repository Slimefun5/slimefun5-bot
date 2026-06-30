// Slimefun5 bot — Cloudflare Worker entry (the front door).
//
//   POST /report        in-game bug reports from the plugin
//   POST /interactions  Discord slash commands (Ed25519-verified)
//
// Routing: when GATEWAY_URL is set AND the VM gateway is reachable, BOTH routes are forwarded to it
// (so everything goes through the VM). If GATEWAY_URL is unset or the VM is down, the Worker handles
// it itself via Cloudflare. Automatic failover, no plugin/Discord reconfig needed.
//
// Secrets/vars: DISCORD_WEBHOOK_URL (#bug-reports), DISCORD_PUBLIC_KEY (app public key),
//               GATEWAY_URL (the VM's public URL, optional), RELAY_KEY (shared secret, optional).

import { handleInteraction, postReportTo } from './src/commands.js';

const FORWARD_TIMEOUT_MS = 1800;

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
  if (!env.GATEWAY_URL && !env.DISCORD_WEBHOOK_URL) return json({ error: 'unconfigured' }, 503);

  if (env.REPORT_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.REPORT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429);
  }

  const raw = await request.text();

  const forwarded = await forwardToGateway(env, '/report', raw);
  if (forwarded) return json({ ok: true, via: 'gateway' }, 200);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const title = clean(body.title, 120);
  const description = clean(body.description, 1800);
  const plugins = pluginList(body.plugins);
  if (!title && !description) return json({ error: 'empty_report' }, 400);

  const meta = `**Player:** ${clean(body.player, 80) || 'unknown'}  **Slimefun:** ${clean(body.sfVersion, 80) || '?'}  **MC:** ${clean(body.mcVersion, 80) || '?'}`;
  const ok = await postReportTo(env.DISCORD_WEBHOOK_URL, { title, description, plugins, meta });
  return ok ? json({ ok: true, via: 'worker' }, 200) : json({ error: 'discord_failed' }, 502);
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

  const forwarded = await forwardToGateway(env, '/interactions', raw);
  if (forwarded) {
    return new Response(await forwarded.text(), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const response = await handleInteraction(interaction, {
    env,
    postReport: (report) => postReportTo(env.DISCORD_WEBHOOK_URL, report)
  });
  return json(response);
}

/** Forwards a request to the VM gateway when configured + reachable; returns the Response or null. */
async function forwardToGateway (env, path, rawBody) {
  if (!env.GATEWAY_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env.RELAY_KEY) headers['X-Relay-Key'] = env.RELAY_KEY;

    const resp = await fetch(env.GATEWAY_URL.replace(/\/$/, '') + path, {
      method: 'POST', headers, body: rawBody, signal: controller.signal
    });
    return resp.ok ? resp : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function json (obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
