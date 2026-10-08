import { ActivityType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config.ts";
import { registerDeletedMessageAudit } from "./features/deleted-message-audit.ts";
import { registerMemberNotifications } from "./features/member-notifications.ts";
import { registerGithubReferences } from "./features/github-references.ts";
import { createGhostPingReporter } from "./features/ghost-ping.ts";

const client = new Client({
  presence: {
    status: "online",
    activities: [{ name: "12pit", type: ActivityType.Playing }],
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
  allowedMentions: { parse: [], repliedUser: false },
});

async function failStartup(error: unknown) {
  console.error("[startup]", error);
  process.exitCode = 1;
  await client.destroy();
}

client.on(Events.Error, (error) => console.error("[discord]", error));
client.on(Events.Warn, (warning) => console.warn("[discord]", warning));

client.once(Events.ClientReady, (readyClient) => {
  void registerMemberNotifications(readyClient)
    .then(async (guildId) => {
      await registerDeletedMessageAudit(readyClient, createGhostPingReporter(readyClient));
      registerGithubReferences(readyClient, guildId);
      console.info(`[ready] Logged in as ${readyClient.user.tag}`);
    })
    .catch(failStartup);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void client.destroy().catch((error) => {
      console.error("[shutdown]", error);
      process.exitCode = 1;
    });
  });
}

if (!config.token) {
  console.error("[startup] Set DISCORD_TOKEN in .env or the environment.");
  process.exitCode = 1;
} else {
  void client.login(config.token).catch(failStartup);
}
