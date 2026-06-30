# Slimefun5 Bot

The Slimefun5 community Discord bot. **One repo, two ways to run it:**

| Run mode | How | Features |
|----------|-----|----------|
| **Cloudflare Worker** (no VM) | `worker.js` | In-game bug-report relay + slash commands |
| **Node gateway** (on a VM) | `gateway.js` | Everything above **plus** live message filters / auto-replies |

Both share the slash commands in `src/commands.js`. The message filters (anti-invite, the
"It's Slimefun, not …" auto-reply) need a persistent gateway connection, so they only run in the VM
mode — a Worker can't read message content.

### Routing (automatic failover)
The **Worker is the single front door**: the plugin always posts to it, and Discord's interactions
endpoint points at it. If `GATEWAY_URL` is set on the Worker **and the VM is reachable**, the Worker
**forwards** both `/report` and `/interactions` to the VM (so everything runs through the VM). If the
VM is down or `GATEWAY_URL` is unset, the Worker handles it itself. No plugin/Discord reconfig needed
when you start or stop the VM.

## Slash commands
`/ping` · `/version` · `/wiki <term>` · `/addon <name>` · `/report <title> <description> [plugin]`

## Mode A — Cloudflare Worker (no VM)

Handles `POST /report` (the plugin relay) and `POST /interactions` (slash commands).

1. **Deploy** — connect this repo in Cloudflare → Workers & Pages → Create → Connect to Git (uses
   `wrangler.toml`; auto-deploys on push).
2. **Secrets** (Worker → Settings → Variables and Secrets):
   - `DISCORD_WEBHOOK_URL` — your `#bug-reports` channel webhook.
   - `DISCORD_PUBLIC_KEY` — the Discord application's public key (only needed for slash commands).
   - `GATEWAY_URL` *(optional)* — the VM's public URL (e.g. your Koyeb app URL). When set and the VM is
     up, the Worker forwards everything to it; otherwise it handles things itself.
   - `RELAY_KEY` *(optional)* — a shared secret; if set here and on the VM, the VM only accepts
     forwards carrying it.
3. **Register the commands** once (locally): `DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… node register.js`
4. In the Discord Developer Portal, set the app's **Interactions Endpoint URL** to
   `https://slimefun5-bot.<you>.workers.dev/interactions`.

Per-IP rate limiting is built in (`[[ratelimits]]` in `wrangler.toml`).

## Mode B — Node gateway (VM, all features)

1. Set env: `DISCORD_BOT_TOKEN` (required), `DISCORD_WEBHOOK_URL` (#bug-reports), `GITHUB_OWNER`
   (optional), `RELAY_KEY` (optional, must match the Worker), `PORT` (the host sets this; the bot
   listens on it and exposes `/health` for the host's health check).
2. `npm install && node register.js` (once) then `node gateway.js` — or use the `Dockerfile`.
3. Point the Worker at it: set the Worker's `GATEWAY_URL` to this VM's public URL. Now everything
   flows through the VM while it's up, and falls back to Cloudflare when it isn't.

### Free always-on hosts (Oracle & Koyeb excluded)
The host must be always-on **and** expose a public URL (so the Worker can forward to it), which rules
out the free Discord-bot hosts (no inbound URL).
- **Render (free web service) + a keep-alive pinger** — no card. Deploys this repo's `Dockerfile`,
  gives a public `*.onrender.com` URL, auto-deploys on push. Render sleeps on idle, so add a free
  uptime pinger (UptimeRobot) hitting `/health` every 5 min to keep the gateway connected. Recommended.
- **Fly.io** — `fly launch` (detects the `Dockerfile`); always-on, public `*.fly.dev` URL, deploy from
  GitHub via Actions. Needs a card on file (small free allowance).
- **Home machine + Cloudflare Tunnel** — fully free if you have any always-on box; the tunnel gives the
  public URL for `GATEWAY_URL`.

Whichever you pick, put its public URL into the Worker's `GATEWAY_URL`.

## Moderation without the VM
Discord's built-in **AutoMod** covers scam-link and invite blocking natively (no bot). Use it
alongside Mode A if you don't run the VM; Mode B adds the conversational auto-replies on top.

## Anti-spam
- Per player: the plugin enforces a report cooldown (`bug-reports.cooldown-seconds`).
- Per IP: the Worker rate-limits `/report` (10/min/IP).
