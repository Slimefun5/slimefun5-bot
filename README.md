# Slimefun5 Bot

The Slimefun5 community Discord bot. **One repo, two ways to run it:**

| Run mode | How | Features |
|----------|-----|----------|
| **Cloudflare Worker** (no VM) | `worker.js` | In-game bug-report relay + slash commands |
| **Node gateway** (on a VM) | `gateway.js` | Everything above **plus** live message filters / auto-replies |

Both share the slash commands in `src/commands.js`. The message filters (anti-invite, the
"It's Slimefun, not …" auto-reply) need a persistent gateway connection, so they only run in the VM
mode — a Worker can't read message content.

## Slash commands
`/ping` · `/version` · `/wiki <term>` · `/addon <name>` · `/report <title> <description> [plugin]`

## Mode A — Cloudflare Worker (no VM)

Handles `POST /report` (the plugin relay) and `POST /interactions` (slash commands).

1. **Deploy** — connect this repo in Cloudflare → Workers & Pages → Create → Connect to Git (uses
   `wrangler.toml`; auto-deploys on push).
2. **Secrets** (Worker → Settings → Variables and Secrets):
   - `DISCORD_WEBHOOK_URL` — your `#bug-reports` channel webhook.
   - `DISCORD_PUBLIC_KEY` — the Discord application's public key (only needed for slash commands).
3. **Register the commands** once (locally): `DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… node register.js`
4. In the Discord Developer Portal, set the app's **Interactions Endpoint URL** to
   `https://slimefun5-bot.<you>.workers.dev/interactions`.

Per-IP rate limiting is built in (`[[ratelimits]]` in `wrangler.toml`).

## Mode B — Node gateway (VM, all features)

1. Set env: `DISCORD_BOT_TOKEN` (required), `DISCORD_WEBHOOK_URL` (#bug-reports), `GITHUB_OWNER` (optional).
2. `npm install && node register.js` (once) then `node gateway.js` — or use the `Dockerfile`.

### Free always-on hosts (Oracle excluded)
- **Koyeb** — free instance; connect this GitHub repo, it builds from the `Dockerfile` and redeploys
  on push. Set the env vars in the service. Simplest GitHub sync.
- **Fly.io** — free allowance; `fly launch` (detects the `Dockerfile`) + `fly secrets set …`, deploy
  from GitHub via a small Actions workflow (`flyctl deploy`).
- Avoid Render's free web service (it sleeps → drops the gateway).

## Moderation without the VM
Discord's built-in **AutoMod** covers scam-link and invite blocking natively (no bot). Use it
alongside Mode A if you don't run the VM; Mode B adds the conversational auto-replies on top.

## Anti-spam
- Per player: the plugin enforces a report cooldown (`bug-reports.cooldown-seconds`).
- Per IP: the Worker rate-limits `/report` (10/min/IP).
