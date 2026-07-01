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

import { handleInteraction, runCommand, postReportTo, resolveTag, formatTagList } from './src/commands.js';

const FORWARD_TIMEOUT_MS = 1800;

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ service: 'slimefun5-bot', build: 'defer-2026-07-01', deferred: true });
    }
    if (request.method === 'GET' && url.pathname === '/tag') {
      return handleTagLookup(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/tags') {
      return json({ content: await formatTagList(makeStore(env)) });
    }
    if (request.method === 'POST' && url.pathname === '/admin/import-tags') {
      return handleImportTags(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/command') {
      return handleCommandRelay(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/report') {
      return handleReport(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/interactions') {
      return handleInteractions(request, env, ctx);
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

async function handleInteractions (request, env, ctx) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const raw = await request.text();

  const verified = !!(env.DISCORD_PUBLIC_KEY && signature && timestamp && await verify(raw, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  console.log(`/interactions hit: hasKey=${!!env.DISCORD_PUBLIC_KEY} hasSig=${!!signature} verified=${verified}`);

  if (!verified) {
    return new Response('bad request signature', { status: 401 });
  }

  const interaction = JSON.parse(raw);
  console.log(`/interactions: type=${interaction.type} command=${interaction.data && interaction.data.name}`);
  if (interaction.type === 1) return json({ type: 1 });

  if (interaction.type === 2) {
    // ACK within Discord's 3s window, then do the work + edit the reply in (15-min follow-up window).
    ctx.waitUntil(respondToCommand(interaction, env));
    return json({ type: 5 });
  }

  if (interaction.type === 4) {
    return json(await buildAutocomplete(interaction, env)); // slash-command option autocomplete (e.g. /faq)
  }

  return json({ type: 4, data: { content: 'Unsupported interaction.' } });
}

async function respondToCommand (interaction, env) {
  let content = '⚠️ Something went wrong handling that command.';
  try {
    if (interaction.data?.name === 'helpful') {
      // Role changes need the gateway (guild access); the Worker can't touch roles itself.
      content = await toggleHelpfulViaGateway(interaction, env);
    } else {
      const response = await handleInteraction(interaction, {
        env,
        postReport: (report) => postReportTo(env.DISCORD_WEBHOOK_URL, report),
        store: makeStore(env)
      });
      content = response?.data?.content || content;
    }
  } catch (e) {
    content = '⚠️ ' + (e?.message || 'error');
  }

  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    });
    console.log(`followup: status=${resp.status} appId=${interaction.application_id ? 'yes' : 'NO'} content="${content}"`);
    if (!resp.ok) console.log('followup error body: ' + (await resp.text()));
  } catch (e) {
    console.log('followup threw: ' + (e && e.message ? e.message : e));
  }
}

/** Bulk-loads tag/alias entries into KV. Guarded by RELAY_KEY; only tag:/alias: keys are accepted. */
async function handleImportTags (request, env) {
  if (!env.RELAY_KEY || request.headers.get('X-Relay-Key') !== env.RELAY_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.TAGS) return json({ error: 'no_kv' }, 503);

  let entries;
  try {
    entries = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  if (!Array.isArray(entries)) return json({ error: 'expected_array' }, 400);

  const incoming = new Set(entries.filter((e) => e && typeof e.key === 'string').map((e) => e.key));

  // Replace mode: drop existing tag:/alias: keys not in the new set (warn: keys are left untouched).
  let deleted = 0;
  const existing = await env.TAGS.list();
  for (const { name } of existing.keys) {
    if ((name.startsWith('tag:') || name.startsWith('alias:')) && !incoming.has(name)) {
      await env.TAGS.delete(name);
      deleted++;
    }
  }

  let written = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') continue;
    if (!entry.key.startsWith('tag:') && !entry.key.startsWith('alias:')) continue;
    await env.TAGS.put(entry.key, entry.value);
    written++;
  }
  return json({ ok: true, written, deleted });
}

/** Builds autocomplete choices (max 25) of tag names matching the focused option's typed text. */
async function buildAutocomplete (interaction, env) {
  const focused = (interaction.data?.options || []).find((o) => o.focused);
  const typed = String(focused?.value || '').toLowerCase();
  const store = makeStore(env);
  if (!store) return { type: 8, data: { choices: [] } };

  const names = (await store.list('tag:')).map((k) => k.slice(4)).sort();
  const matches = names.filter((n) => n.includes(typed)).slice(0, 25);
  return { type: 8, data: { choices: matches.map((n) => ({ name: n, value: n })) } };
}

/** Runs a command relayed from the gateway (a `!`/`?` prefix command). Guarded by RELAY_KEY. */
async function handleCommandRelay (request, env) {
  if (!env.RELAY_KEY || request.headers.get('X-Relay-Key') !== env.RELAY_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const content = await runCommand({
    name: body.name,
    env,
    subcommand: body.subcommand || null,
    options: body.options || {},
    resolvedUsers: body.resolvedUsers || {},
    author: body.author || 'someone',
    isStaff: !!body.isStaff,
    store: makeStore(env),
    postReport: (report) => postReportTo(env.DISCORD_WEBHOOK_URL, report)
  });
  return json({ content });
}

/** Returns the content of a stored tag by name, for the gateway's `?name` chat lookups. */
async function handleTagLookup (url, env) {
  const name = (url.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (!env.TAGS || !name) return json({ error: 'not_found' }, 404);
  const content = await resolveTag(makeStore(env), name);
  return content ? json({ name, content }) : json({ error: 'not_found' }, 404);
}

/** Wraps the TAGS KV namespace in the small store interface the shared commands expect (null if unbound). */
function makeStore (env) {
  if (!env.TAGS) return null;
  return {
    get: (key) => env.TAGS.get(key),
    put: (key, value) => env.TAGS.put(key, value),
    delete: (key) => env.TAGS.delete(key),
    list: async (prefix) => (await env.TAGS.list({ prefix })).keys.map((k) => k.name)
  };
}

/** Asks the gateway to toggle the Helpful role for the interaction's user; returns the reply text. */
async function toggleHelpfulViaGateway (interaction, env) {
  const unavailable = 'The Helpful role is only available while the bot is fully online. Try again shortly.';
  if (!env.GATEWAY_URL) return unavailable;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env.RELAY_KEY) headers['X-Relay-Key'] = env.RELAY_KEY;
    const resp = await fetch(env.GATEWAY_URL.replace(/\/$/, '') + '/helpful', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: interaction.member?.user?.id, guildId: interaction.guild_id })
    });
    if (!resp.ok) return unavailable;
    return (await resp.json()).content || 'Done.';
  } catch {
    return unavailable;
  }
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
