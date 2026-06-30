// Slimefun5 bot — Node gateway entry (run on a VM for ALL features).
//
// Reuses the same slash commands as the Worker, and ADDS what a Worker can't do: live message
// filters / auto-replies (these need a persistent gateway connection).
//
// Env: DISCORD_BOT_TOKEN (required), DISCORD_WEBHOOK_URL (#bug-reports), GITHUB_OWNER (optional).
// Register the slash commands once with `node register.js`.

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './src/commands.js';

const env = { GITHUB_OWNER: process.env.GITHUB_OWNER || 'Slimefun5' };
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

const SLIMEFUN = /Slime(?:F|( f))un/;
const INVITE = /discord\.gg\/([A-Za-z0-9]+)/i;
const OUR_INVITE = 'cbbyzbewdr';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, (c) => console.log(`Slimefun5 bot online as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands[interaction.commandName];
  if (!command) return;

  const ctx = {
    env,
    getString: (name) => interaction.options.getString(name) || '',
    postReport: (report) => postReport({ ...report, meta: `**By:** ${interaction.user.username} (Discord)` })
  };

  try {
    await interaction.deferReply();
    await interaction.editReply(await command.run(ctx));
  } catch (e) {
    console.error('command failed', e);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const invite = message.content.match(INVITE);
  if (invite && invite[1].toLowerCase() !== OUR_INVITE) {
    await message.delete().catch(() => {});
    await message.channel.send(`${message.author}, please don't post other server invites here.`).catch(() => {});
    return;
  }

  const match = SLIMEFUN.exec(message.content);
  if (match && match[0] !== 'Slimefun') {
    await message.reply(`It's Slimefun, not ${match[0]} 🙂`).catch(() => {});
  }
});

async function postReport (report) {
  if (!webhookUrl) return false;

  const plugins = Array.isArray(report.plugins) ? report.plugins.join(', ') : (report.plugins || '(unspecified)');
  const content = `**Bug Report: ${report.title || '(no title)'}**\n**Plugins:** ${plugins}\n`
    + (report.meta ? report.meta + '\n' : '') + '\n' + (report.description || '');

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } })
  });
  return resp.ok;
}

client.login(process.env.DISCORD_BOT_TOKEN);
