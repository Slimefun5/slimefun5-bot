// Slimefun5 bug-report relay (Cloudflare Worker).
//
// Receives POST /report from the Slimefun plugin and forwards it to our Discord #bug-reports
// channel via a webhook. The webhook URL lives ONLY here, as the secret DISCORD_WEBHOOK_URL — it is
// never shipped in the public plugin jar, so server operators can't read or redirect it.
//
// Deploy: see README.md. Set the secret with:  npx wrangler secret put DISCORD_WEBHOOK_URL

const MAX_MESSAGE = 1800;
const MAX_FIELD = 80;

export default {
  async fetch (request, env) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const url = new URL(request.url);
    if (url.pathname !== '/report') return json({ error: 'not_found' }, 404);
    if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'unconfigured' }, 503);

    // Per-IP rate limit (anti-flood). Guarded so the Worker still runs if the binding is absent.
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
    const plugins = Array.isArray(body.plugins)
      ? body.plugins.map(x => clean(x, 40)).filter(Boolean).slice(0, 25).join(', ')
      : clean(body.plugins, 200);
    const player = clean(body.player, MAX_FIELD);
    const sf = clean(body.sfVersion, MAX_FIELD);
    const mc = clean(body.mcVersion, MAX_FIELD);

    if (!title && !description) return json({ error: 'empty_report' }, 400);

    const content = `**Bug Report: ${title || '(no title)'}**\n`
      + `**Plugins:** ${plugins || '(unspecified)'}\n`
      + `**Player:** ${player || 'unknown'}  **Slimefun:** ${sf || '?'}  **MC:** ${mc || '?'}\n\n`
      + (description || '(no description)');

    const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions empty => a report can never ping @everyone/roles.
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } })
    });

    if (!resp.ok) return json({ error: 'discord_failed' }, 502);
    return json({ ok: true }, 200);
  }
};

// Strips backticks/mentions, trims, and caps length so a report can't break formatting or abuse pings.
function clean (value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[`@]/g, '').trim().slice(0, max);
}

function json (obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
