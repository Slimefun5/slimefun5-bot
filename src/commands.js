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

// Discord permission bits used to gate moderator commands.
const ADMINISTRATOR = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATE_MEMBERS = 1n << 40n;

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING_OPTION = 3;
const USER_OPTION = 6;

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
  },

  tag: {
    definition: {
      name: 'tag',
      description: 'Canned FAQ replies (also triggered in chat with ?name)',
      options: [
        { name: 'get', description: 'Show a tag', type: SUB_COMMAND, options: [{ name: 'name', description: 'Tag name', type: STRING_OPTION, required: true }] },
        { name: 'list', description: 'List all tags', type: SUB_COMMAND },
        { name: 'create', description: 'Create or overwrite a tag (staff)', type: SUB_COMMAND, options: [
          { name: 'name', description: 'Tag name', type: STRING_OPTION, required: true },
          { name: 'content', description: 'Reply text — use \\n for line breaks', type: STRING_OPTION, required: true }
        ] },
        { name: 'alias', description: 'Point an alias at an existing tag (staff)', type: SUB_COMMAND, options: [
          { name: 'name', description: 'The alias', type: STRING_OPTION, required: true },
          { name: 'target', description: 'The tag it points to', type: STRING_OPTION, required: true }
        ] },
        { name: 'delete', description: 'Delete a tag and its aliases (staff)', type: SUB_COMMAND, options: [{ name: 'name', description: 'Tag name', type: STRING_OPTION, required: true }] }
      ]
    },
    async run(ctx) {
      if (!ctx.store) return '⚠️ Tag storage is not configured yet (no KV namespace bound).';
      const name = tagName(ctx.getString('name'));

      if (ctx.subcommand === 'list') {
        return await formatTagList(ctx.store);
      }
      if (ctx.subcommand === 'get') {
        if (!name) return 'Please give a tag name.';
        return (await resolveTag(ctx.store, name)) || `Tag \`${name}\` not found.`;
      }

      if (!ctx.isStaff) return '⛔ You need moderator permissions to manage tags.';
      if (ctx.subcommand === 'create') {
        if (!name) return 'Invalid tag name (use letters, numbers, - or _).';
        const content = ctx.getString('content').replace(/\\n/g, '\n').trim().slice(0, 1800);
        if (!content) return 'Tag content cannot be empty.';
        await ctx.store.put('tag:' + name, content);
        return `✅ Tag \`${name}\` saved.`;
      }
      if (ctx.subcommand === 'alias') {
        const target = tagName(ctx.getString('target'));
        if (!name || !target) return 'Both an alias and a target are required.';
        if (!(await ctx.store.get('tag:' + target))) return `Target tag \`${target}\` does not exist.`;
        await ctx.store.put('alias:' + name, target);
        return `✅ Alias \`${name}\` → \`${target}\` created.`;
      }
      if (ctx.subcommand === 'delete') {
        const existed = await ctx.store.get('tag:' + name);
        const wasAlias = await ctx.store.get('alias:' + name);
        if (!existed && !wasAlias) return `Tag \`${name}\` does not exist.`;
        await ctx.store.delete('tag:' + name);
        await ctx.store.delete('alias:' + name);
        for (const key of await ctx.store.list('alias:')) {
          if (tagName(await ctx.store.get(key)) === name) await ctx.store.delete(key);
        }
        return `🗑️ Tag \`${name}\` and its aliases deleted.`;
      }
      return 'Unknown subcommand.';
    }
  },

  warn: {
    definition: {
      name: 'warn',
      description: 'Moderator warnings',
      options: [
        { name: 'add', description: 'Warn a user (staff)', type: SUB_COMMAND, options: [
          { name: 'user', description: 'User to warn', type: USER_OPTION, required: true },
          { name: 'reason', description: 'Reason', type: STRING_OPTION, required: true }
        ] },
        { name: 'list', description: 'List a user\'s warnings (staff)', type: SUB_COMMAND, options: [{ name: 'user', description: 'User', type: USER_OPTION, required: true }] },
        { name: 'clear', description: 'Clear a user\'s warnings (staff)', type: SUB_COMMAND, options: [{ name: 'user', description: 'User', type: USER_OPTION, required: true }] }
      ]
    },
    async run(ctx) {
      if (!ctx.store) return '⚠️ Warning storage is not configured yet (no KV namespace bound).';
      if (!ctx.isStaff) return '⛔ You need moderator permissions to warn users.';
      const user = ctx.getUser('user');
      if (!user) return 'Please specify a user.';

      const key = 'warn:' + user.id;
      const warnings = JSON.parse((await ctx.store.get(key)) || '[]');

      if (ctx.subcommand === 'add') {
        const reason = ctx.getString('reason').trim().slice(0, 500) || 'No reason given';
        warnings.push({ reason, by: ctx.author, at: ctx.now });
        await ctx.store.put(key, JSON.stringify(warnings));
        return `⚠️ Warned <@${user.id}> — now ${warnings.length} warning(s). Reason: ${reason}`;
      }
      if (ctx.subcommand === 'list') {
        if (!warnings.length) return `<@${user.id}> has no warnings.`;
        return `Warnings for <@${user.id}>:\n` + warnings.map((w, i) => `${i + 1}. ${w.reason} — by ${w.by}`).join('\n');
      }
      if (ctx.subcommand === 'clear') {
        await ctx.store.delete(key);
        return `✅ Cleared ${warnings.length} warning(s) for <@${user.id}>.`;
      }
      return 'Unknown subcommand.';
    }
  },

  helpful: {
    definition: { name: 'helpful', description: 'Toggle the Helpful role on yourself' },
    // Role changes need guild access, so each runtime intercepts "helpful" before this runs;
    // this body is only a fallback if that ever doesn't happen.
    async run() {
      return 'The Helpful role can only be toggled from within the server.';
    }
  }
};

/** Normalizes a tag name to a safe, lowercase key fragment. */
function tagName (raw) {
  return (raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Formats the full tag list (with aliases grouped under each tag) for `/tag list` and `?help`. */
export async function formatTagList (store) {
  if (!store) return '⚠️ Tag storage is not configured yet (no KV namespace bound).';
  const names = (await store.list('tag:')).map((k) => k.slice(4)).sort();
  if (!names.length) return 'No tags yet.';
  const aliasesByTarget = {};
  for (const key of await store.list('alias:')) {
    const target = tagName(await store.get(key));
    (aliasesByTarget[target] ||= []).push(key.slice(6));
  }
  const lines = names.map((name) => {
    const aliases = aliasesByTarget[name];
    return `\`?${name}\`` + (aliases?.length ? ` (${aliases.map((a) => `\`?${a}\``).join(', ')})` : '');
  });
  return `**Available tags (${names.length}):**\n` + lines.join(', ');
}

/** Resolves a tag name to its content, following one alias hop; returns null if unknown. */
export async function resolveTag (store, raw) {
  const name = tagName(raw);
  if (!store || !name) return null;
  const direct = await store.get('tag:' + name);
  if (direct != null) return direct;
  const target = await store.get('alias:' + name);
  return target ? await store.get('tag:' + tagName(target)) : null;
}

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

/**
 * Runs a command by name and returns its reply text. Shared by every entry point (slash interactions
 * on the Worker, and `!`/`?` prefix commands relayed from the gateway) so behaviour is identical.
 */
export async function runCommand ({ name, env = {}, subcommand = null, options = {}, resolvedUsers = {}, author = 'someone', isStaff = false, store = null, postReport = async () => false }) {
  const command = commands[name];
  if (!command) return 'Unknown command.';

  const ctx = {
    env,
    subcommand,
    author,
    isStaff,
    store,
    now: new Date().toISOString(),
    getString: (key) => (options[key] != null ? String(options[key]) : ''),
    getUser: (key) => {
      const id = options[key];
      if (!id) return null;
      const resolved = resolvedUsers[id];
      return { id, username: resolved ? resolved.username : String(id) };
    },
    postReport: (report) => postReport({ ...report, meta: `**By:** ${author} (Discord)` })
  };
  return await command.run(ctx);
}

/** True if a member's Discord permission bitfield grants any moderator-level permission. */
export function isStaffPermissions (permissionBits) {
  const perms = BigInt(permissionBits || '0');
  return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_MESSAGES) !== 0n || (perms & MODERATE_MEMBERS) !== 0n;
}

/** Runs a Discord slash interaction against the shared commands; returns the Discord response object. */
export async function handleInteraction (interaction, { env, postReport, store = null }) {
  if (interaction.type === 1) return { type: 1 };

  if (interaction.type === 2) {
    // A subcommand nests its own options one level down; flatten them and record its name.
    let rawOptions = interaction.data.options || [];
    let subcommand = null;
    if (rawOptions[0] && (rawOptions[0].type === SUB_COMMAND || rawOptions[0].type === SUB_COMMAND_GROUP)) {
      subcommand = rawOptions[0].name;
      rawOptions = rawOptions[0].options || [];
    }
    const options = {};
    for (const option of rawOptions) options[option.name] = option.value;

    const content = await runCommand({
      name: interaction.data.name,
      env,
      subcommand,
      options,
      resolvedUsers: interaction.data.resolved?.users || {},
      author: interaction.member?.user?.username || interaction.user?.username || 'someone',
      isStaff: isStaffPermissions(interaction.member?.permissions),
      store,
      postReport
    });
    return reply(content);
  }

  return reply('Unsupported interaction.');
}

function reply (content) {
  return { type: 4, data: { content, allowed_mentions: { parse: [] } } };
}
