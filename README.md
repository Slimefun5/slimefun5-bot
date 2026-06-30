# Slimefun5 Bot

The shared Slimefun5 service. Today it relays in-game bug reports into our Discord; builds
notifications and the always-on community bot will be folded in here over time.

## Why a relay (and not a webhook in the plugin)

A public plugin jar can't keep a secret — anyone could extract a baked-in webhook URL and spam the
channel, with no way to rate-limit or rotate it. So the Discord webhook lives only in this Worker (as
a secret). The plugin just POSTs reports to the Worker's public URL; the Worker forwards them to our
`#bug-reports`. Every server hits **our** Discord, with nothing sensitive shipped to operators.

## Bug-report relay (Cloudflare Worker — free tier)

### One-time setup
1. In Discord: Server Settings → Integrations → Webhooks → New Webhook on your `#bug-reports`
   channel → Copy Webhook URL.
2. Deploy the Worker — pick **one** path:

   **Option A — Cloudflare dashboard (no install, recommended):**
   - Dashboard → Workers & Pages → Create → Create Worker → name it `slimefun5-bot` → Deploy the
     starter, then Edit code and paste the contents of `worker.js` → Deploy.
   - On the Worker: Settings → Variables and Secrets → add a **Secret** named `DISCORD_WEBHOOK_URL`
     = your `#bug-reports` webhook URL → Save and deploy.

   **Option B — wrangler CLI (needs Node.js; good for repeatable deploys):**
   ```sh
   npm install -g wrangler        # or prefix commands with: npx
   wrangler login
   wrangler secret put DISCORD_WEBHOOK_URL   # paste the webhook URL when prompted
   wrangler deploy
   ```
3. Either way you get a URL like `https://slimefun5-bot.<you>.workers.dev`. The plugin endpoint is that
   URL + `/report`. Put it in the Slimefun config:
   ```yaml
   bug-reports:
     enabled: true
     relay-url: 'https://slimefun5-bot.<you>.workers.dev/report'
   ```
   (Send me the URL and I'll bake it in as the default so no server needs to configure it.)

### Anti-spam (built in)
Two layers, no setup needed:
- **Per player:** the plugin enforces a cooldown (`bug-reports.cooldown-seconds`, default 60s) so one
  player can't spam reports.
- **Per IP:** this Worker uses a Cloudflare rate-limit binding (`[[ratelimits]]` in `wrangler.toml`,
  10 reports/min per IP) so the endpoint can't be hammered directly. Tune the `limit` there.

## Later: always-on community bot

Slash commands need a persistent Discord gateway connection, which Workers can't hold. When we build
that, it goes on a free always-on VM (e.g. Oracle Cloud Free Tier) running this same Node codebase;
the Worker stays as the lightweight report-ingestion front door.
