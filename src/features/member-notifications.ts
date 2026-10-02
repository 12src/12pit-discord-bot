import {
  Events,
  channelMention,
  userMention,
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type TextChannel,
} from "discord.js";
import { config } from "../config.ts";

export async function registerMemberNotifications(client: Client<true>) {
  const channel = (await client.channels.fetch(config.channels.joinLeave)) as TextChannel;

  async function sendNotification(
    member: GuildMember | PartialGuildMember,
    event: "join" | "leave",
  ) {
    if (member.guild.id !== channel.guildId) return;

    const mention = userMention(member.id);
    const content =
      event === "join"
        ? `${mention}, welcome to 12pit's Discord! please check **${channelMention(config.channels.rules)}** for rules and info!`
        : `${mention} has left the server.`;

    try {
      await channel.send({
        content,
        allowedMentions: { parse: [], users: event === "join" ? [member.id] : [] },
      });
    } catch (error) {
      console.error(
        `[member-notifications] Failed to send ${event} for ${member.id}:`,
        error,
      );
    }
  }

  client.on(Events.GuildMemberAdd, (member) => sendNotification(member, "join"));
  client.on(Events.GuildMemberRemove, (member) => sendNotification(member, "leave"));

  return channel.guildId;
}
