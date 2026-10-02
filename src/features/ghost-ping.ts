import { MessageFlags, userMention, type Client, type TextChannel } from "discord.js";
import { config } from "../config.ts";
import type { DeletedMessage, DeleteAuditResult } from "./deleted-message-audit.ts";
import { createReportCards } from "./report-card.ts";

export function createGhostPingReporter(client: Client<true>) {
  return async (deleted: DeletedMessage, result: DeleteAuditResult) => {
    if (
      result.status === "failed" ||
      !deleted.authorId ||
      deleted.authorIsBot ||
      !deleted.hasPing ||
      deleted.deletedAt - deleted.createdAt > config.ghostPing.windowMs
    ) return;
    if (result.status === "matched" && result.entry.executor?.id !== deleted.authorId) return;

    const channel = (await client.channels.fetch(deleted.channelId)) as TextChannel;
    const cards = createReportCards({
      title: "Ghost ping detected",
      color: config.ghostPing.color,
      authorLabel: "Author",
      author: userMention(deleted.authorId),
      avatarUrl: deleted.authorAvatarUrl,
      content: deleted.content,
    });
    for (const card of cards) {
      await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [card],
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  };
}
