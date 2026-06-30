// Shared slash-command definitions + handlers, used by BOTH runtimes:
//   - the Cloudflare Worker (HTTP interactions, no VM)
//   - the Node gateway bot (discord.js, on a VM — adds message filters too)
//
// Each handler is runtime-agnostic: it receives a small ctx and returns a reply string.
//   ctx.getString(name)  -> a string option, or ''
//   ctx.env              -> { GITHUB_OWNER, REPORT_WEBHOOK_URL, ... }
//   ctx.postReport(obj)  -> Promise<boolean>  (platform posts to the #bug-reports webhook)

const OWNER = (env) => (env && env.GITHUB_OWNER) || 'Slimefun5';
const WIKI_BASE = 'https://github.com/Slimefun5/Slimefun5/wiki';

export const commands = {
  ping: {
    definition: { name: 'ping', description: 'Check that the bot is alive' },
    async run() {
      return 'Pong! 🟢';
    }
  },

  version: {
    definition: { name: 'version', description: 'Show the latest Slimefun5 release' },
    async run(ctx) {
      const res = await fetch(`https://api.github.com/repos/${OWNER(ctx.env)}/Slimefun5/releases/latest`, {
        headers: { 'User-Agent': 'slimefun5-bot' }
      });
      if (!res.ok) return 'Could not fetch the latest version right now.';
      const data = await res.json();
      return `Latest Slimefun5 release: **${data.tag_name}** — ${data.html_url}`;
    }
  },

  wiki: {
    definition: {
      name: 'wiki',
      description: 'Link a Slimefun5 wiki page',
      options: [{ name: 'term', description: 'What to look up', type: 3, required: true }]
    },
    async run(ctx) {
      const term = ctx.getString('term').trim();
      return `🔎 ${WIKI_BASE}/${encodeURIComponent(term.replace(/\s+/g, '-'))}`;
    }
  },

  addon: {
    definition: {
      name: 'addon',
      description: 'Show an addon\'s links',
      options: [{ name: 'name', description: 'The addon repository name', type: 3, required: true }]
    },
    async run(ctx) {
      const name = ctx.getString('name').trim().replace(/[^A-Za-z0-9_-]/g, '');
      if (!name) return 'Please give an addon name.';
      const repo = `https://github.com/${OWNER(ctx.env)}/${name}`;
      return `**${name}**\n• GitHub: ${repo}\n• Issues: ${repo}/issues`;
    }
  },

  report: {
    definition: {
      name: 'report',
      description: 'File a bug report to the Slimefun5 team',
      options: [
        { name: 'title', description: 'Short summary', type: 3, required: true },
        { name: 'description', description: 'What happened', type: 3, required: true },
        { name: 'plugin', description: 'Affected plugin/addon', type: 3, required: false }
      ]
    },
    async run(ctx) {
      const title = ctx.getString('title').trim();
      const description = ctx.getString('description').trim();
      const plugin = ctx.getString('plugin').trim() || 'unspecified';
      const ok = await ctx.postReport({ title, description, plugins: [plugin] });
      return ok ? '✅ Thanks — your report was sent.' : '⚠️ Could not send your report right now.';
    }
  }
};

/** Registration payload (array of command definitions) for the Discord API. */
export function commandDefinitions() {
  return Object.values(commands).map((c) => c.definition);
}

/** Builds the Discord message content for a bug report. */
export function formatReport ({ title, description, plugins, meta }) {
  const list = Array.isArray(plugins) ? plugins.join(', ') : (plugins || '(unspecified)');
  return `**Bug Report: ${title || '(no title)'}**\n**Plugins:** ${list}\n`
    + (meta ? meta + '\n' : '') + '\n' + (description || '(no description)');
}

/** Posts a formatted report to a Discord webhook. Returns whether it succeeded. */
export async function postReportTo (webhookUrl, fields) {
  if (!webhookUrl) return false;
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: formatReport(fields).slice(0, 2000), allowed_mentions: { parse: [] } })
  });
  return resp.ok;
}

/** Runs a Discord interaction against the shared commands; returns the Discord response object. */
export async function handleInteraction (interaction, { env, postReport }) {
  if (interaction.type === 1) return { type: 1 };

  if (interaction.type === 2) {
    const command = commands[interaction.data.name];
    if (!command) return reply('Unknown command.');

    const options = {};
    for (const option of interaction.data.options || []) options[option.name] = option.value;
    const author = interaction.member?.user?.username || interaction.user?.username || 'someone';

    const ctx = {
      env,
      getString: (name) => (options[name] != null ? String(options[name]) : ''),
      postReport: (report) => postReport({ ...report, meta: `**By:** ${author} (Discord)` })
    };
    return reply(await command.run(ctx));
  }

  return reply('Unsupported interaction.');
}

function reply (content) {
  return { type: 4, data: { content, allowed_mentions: { parse: [] } } };
}
