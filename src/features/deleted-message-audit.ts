import {
  AuditLogEvent,
  Events,
  MessageFlags,
  channelMention,
  userMention,
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
  type Message,
  type PartialMessage,
  type PartialUser,
  type TextChannel,
  type User,
} from "discord.js";
import { config } from "../config.ts";
import { createReportCards } from "./report-card.ts";

const CACHE_TTL_MS = config.messageCache.ttlMs;
const MAX_CACHE_SIZE = config.messageCache.maxSize;
const AUDIT_MINUTE_MS = 60 * 1_000;
const AUDIT_GRACE_MS = config.deletedMessageAudit.graceMs;
const AUDIT_RETRY_DELAY_MS = config.deletedMessageAudit.retryDelayMs;

type CachedMessage = {
  guildId: string;
  channelId: string;
  authorId?: string;
  authorName?: string;
  authorIsBot: boolean;
  content: string;
  hasPing: boolean;
  createdAt: number;
  cachedAt: number;
};

export type DeletedMessage = CachedMessage & {
  messageId: string;
  deletedAt: number;
};

type DeleteAuditAction = AuditLogEvent.MessageDelete | AuditLogEvent.MessageBulkDelete;
type DeleteAuditEntry = GuildAuditLogsEntry<DeleteAuditAction>;
type Executor = User | PartialUser;
export type DeleteAuditResult =
  | { status: "matched"; entry: DeleteAuditEntry }
  | { status: "unmatched" }
  | { status: "failed" };

type DeletionObserver = (deleted: DeletedMessage, result: DeleteAuditResult) => Promise<void>;

type UsedAuditEntry = {
  count: number;
  available: number;
  expiresAt: number;
};

type DeleteBatch = {
  key: string;
  guildId: string;
  executorId: string;
  minuteBucket: number;
  messages: DeletedMessage[];
  cards: Message[];
  finalizeTimer: ReturnType<typeof setTimeout>;
};

function hasPing(message: Message | PartialMessage) {
  return message.mentions.everyone || message.mentions.roles.size > 0 ||
    [...message.mentions.users.keys()].some((id) => id !== message.author?.id);
}

function rememberMessage(
  cache: Map<string, CachedMessage>,
  message: Message | PartialMessage,
  mergePartial = false,
) {
  if (!message.guildId) return;

  const previous = cache.get(message.id);
  const author = message.author;
  const content = mergePartial && message.partial
    ? previous?.content ?? ""
    : message.content ?? previous?.content ?? "";

  cache.set(message.id, {
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: author?.id ?? previous?.authorId,
    authorName: author?.tag ?? previous?.authorName,
    authorIsBot: author?.bot ?? previous?.authorIsBot ?? false,
    content,
    hasPing: mergePartial && message.partial ? previous?.hasPing ?? false : hasPing(message),
    createdAt: message.createdTimestamp,
    cachedAt: Date.now(),
  });

  const now = Date.now();
  for (const [id, item] of cache) {
    if (now - item.cachedAt > CACHE_TTL_MS) cache.delete(id);
  }
  while (cache.size > MAX_CACHE_SIZE) {
    const oldestId = cache.keys().next().value;
    if (!oldestId) break;
    cache.delete(oldestId);
  }
}

function getDeletedMessage(
  cache: Map<string, CachedMessage>,
  message: Message | PartialMessage,
): DeletedMessage | null {
  if (!message.guildId) return null;

  const cached = cache.get(message.id);
  const author = message.author;
  const deleted: DeletedMessage = {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: author?.id ?? cached?.authorId,
    authorName: author?.tag ?? cached?.authorName,
    authorIsBot: author?.bot ?? cached?.authorIsBot ?? false,
    content: message.content ?? cached?.content ?? "",
    hasPing: message.partial ? cached?.hasPing ?? false : hasPing(message),
    createdAt: message.createdTimestamp,
    cachedAt: cached?.cachedAt ?? Date.now(),
    deletedAt: Date.now(),
  };

  cache.delete(message.id);
  return deleted;
}

function getAuditChannelId(extra: unknown) {
  if (!extra || typeof extra !== "object") return undefined;
  const channel = (extra as { channel?: unknown }).channel;
  if (!channel || typeof channel !== "object") return undefined;
  const id = (channel as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function getTargetId(target: unknown) {
  if (!target || typeof target !== "object") return undefined;
  const id = (target as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function getAuditCount(extra: unknown) {
  if (!extra || typeof extra !== "object") return 1;
  const count = (extra as { count?: unknown }).count;
  return typeof count === "number" ? count : 1;
}

function isSameAuditMinute(deletedAt: number, auditCreatedAt: number) {
  const deletedMinute = Math.floor(deletedAt / AUDIT_MINUTE_MS);
  const auditMinute = Math.floor(auditCreatedAt / AUDIT_MINUTE_MS);
  return deletedMinute === auditMinute || (
    Math.abs(deletedAt - auditCreatedAt) <= AUDIT_GRACE_MS &&
    Math.abs(deletedMinute - auditMinute) === 1
  );
}

function auditUsageKey(action: DeleteAuditAction, entryId: string) {
  return `${action}:${entryId}`;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function findAuditEntry(
  guild: Guild,
  deleted: DeletedMessage,
  action: DeleteAuditAction,
  preferredExecutorIds: ReadonlySet<string>,
  usedEntries: Map<string, UsedAuditEntry>,
  startedAt: number,
  requiredCount = 1,
): Promise<DeleteAuditResult> {
  for (let attempt = 0; attempt < config.deletedMessageAudit.retryAttempts; attempt += 1) {
    try {
      const auditLogs = await guild.fetchAuditLogs({
        type: action,
        limit: config.deletedMessageAudit.fetchLimit,
      });
      const now = Date.now();
      for (const [key, usage] of usedEntries) {
        if (usage.expiresAt <= now) usedEntries.delete(key);
      }

      const candidates = [...auditLogs.entries.values()].filter((candidate) => {
        if (candidate.action !== action) return false;
        if (!isSameAuditMinute(deleted.deletedAt, candidate.createdTimestamp)) {
          return false;
        }

        const auditChannelId = action === AuditLogEvent.MessageBulkDelete
          ? candidate.targetId
          : getAuditChannelId(candidate.extra);
        return !auditChannelId || auditChannelId === deleted.channelId;
      });

      const exactTarget = candidates.filter((candidate) => {
        const targetId = getTargetId(candidate.target);
        return action === AuditLogEvent.MessageBulkDelete ||
          !deleted.authorId || !targetId || targetId === deleted.authorId;
      });
      const foldedEntries = candidates.filter((candidate) => getAuditCount(candidate.extra) > 1);
      const orderedCandidates = [
        ...candidates.filter((candidate) =>
          candidate.executor?.id && preferredExecutorIds.has(candidate.executor.id),
        ),
        ...exactTarget,
        ...foldedEntries,
        ...candidates,
      ].filter((candidate, index, all) => all.indexOf(candidate) === index);

      for (const candidate of orderedCandidates) {
        if (!candidate.executor?.id) continue;

        const key = auditUsageKey(action, candidate.id);
        const count = Math.max(1, getAuditCount(candidate.extra));
        const previous = usedEntries.get(key);
        const expiresAt = Math.floor(deleted.deletedAt / AUDIT_MINUTE_MS + 1) *
          AUDIT_MINUTE_MS + AUDIT_GRACE_MS;

        if (!previous && candidate.createdTimestamp < startedAt) {
          usedEntries.set(key, { count, available: 0, expiresAt });
          continue;
        }

        const usage = previous ?? { count: 0, available: 0, expiresAt };
        if (count > usage.count) usage.available += count - usage.count;
        usage.count = Math.max(usage.count, count);
        usage.expiresAt = Math.max(expiresAt, now + AUDIT_GRACE_MS);
        if (usage.available < requiredCount) {
          usedEntries.set(key, usage);
          continue;
        }

        usage.available -= requiredCount;
        usedEntries.set(key, usage);
        return { status: "matched", entry: candidate };
      }

    } catch (error) {
      console.error(`[deleted-message-audit] Failed to read audit logs in ${guild.id}:`, error);
      return { status: "failed" };
    }

    if (attempt + 1 < config.deletedMessageAudit.retryAttempts) {
      await wait(AUDIT_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  return { status: "unmatched" };
}

function batchKey(guildId: string, executorId: string, minuteBucket: number) {
  return `${guildId}:${executorId}:${minuteBucket}`;
}

function batchReport(messages: DeletedMessage[]) {
  const report = messages.map((deleted, index) => [
    `Message ${index + 1}`,
    `Author: ${deleted.authorId ?? "Unknown"}`,
    `Channel: ${deleted.channelId}`,
    `Message ID: ${deleted.messageId}`,
    "",
    deleted.content.trim() || "No text available.",
  ].join("\n")).join("\n\n---\n\n");

  return report.length > 100_000
    ? `${report.slice(0, 100_000)}\n\n[Report truncated]`
    : report;
}

export async function registerDeletedMessageAudit(client: Client<true>, onDeletion: DeletionObserver) {
  const adminChannel = (await client.channels.fetch(config.channels.admin)) as TextChannel;

  const cache = new Map<string, CachedMessage>();
  const ownAuditMessageIds = new Set<string>();
  const batches = new Map<string, DeleteBatch>();
  const auditStartedAt = Date.now();
  const usedAuditEntries = new Map<string, UsedAuditEntry>();
  let auditQueue = Promise.resolve();

  function trackOwnCard(card: Message) {
    ownAuditMessageIds.add(card.id);
    while (ownAuditMessageIds.size > MAX_CACHE_SIZE) {
      const oldestId = ownAuditMessageIds.values().next().value;
      if (!oldestId) break;
      ownAuditMessageIds.delete(oldestId);
    }
    cache.delete(card.id);
  }

  async function sendSingleCard(deleted: DeletedMessage, executor: Executor) {
    const cards = createReportCards({
      title: "Message deleted",
      color: config.deletedMessageAudit.color,
      authorLabel: "Author",
      author: deleted.authorId ? userMention(deleted.authorId) : "Unknown",
      content: deleted.content,
      details: [
        `-# Channel: ${channelMention(deleted.channelId)}`,
        `-# Probably deleted by: ${userMention(executor.id)}`,
        `-# <t:${Math.floor(deleted.deletedAt / 1_000)}:f>`,
      ].join("\n"),
    });
    const sent: Message[] = [];
    for (const card of cards) {
      const message = await adminChannel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [card],
        allowedMentions: { parse: [] },
      });
      trackOwnCard(message);
      sent.push(message);
    }
    return sent;
  }

  async function sendBatchCard(batch: DeleteBatch, executor: Executor) {
    const channels = [...new Set(batch.messages.map((deleted) => deleted.channelId))]
      .map(channelMention);
    const channelText = channels.length > 10
      ? `${channels.slice(0, 10).join(", ")} and ${channels.length - 10} more`
      : channels.join(", ");
    const [card] = createReportCards({
      title: "Bulk deletion",
      color: config.deletedMessageAudit.color,
      authorLabel: "Probably deleted by",
      author: userMention(executor.id),
      content: "Deleted message contents are attached.",
      details: [
        `-# Messages: ${batch.messages.length}`,
        `-# Channels: ${channelText}`,
        `-# <t:${Math.floor((batch.messages[0]?.deletedAt ?? Date.now()) / 1_000)}:f>`,
      ].join("\n"),
      attachmentName: "deleted-messages.txt",
    });
    const sent = await adminChannel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [card!],
      files: [
        {
          attachment: Buffer.from(batchReport(batch.messages), "utf8"),
          name: "deleted-messages.txt",
        },
      ],
      allowedMentions: { parse: [] },
    });

    trackOwnCard(sent);
  }

  async function finalizeBatch(batch: DeleteBatch, executor: Executor) {
    if (batches.get(batch.key) !== batch) return;
    batches.delete(batch.key);

    if (batch.messages.length < 2) return;

    await Promise.all(batch.cards.map((card) => card.delete().catch(() => undefined)));
    batch.cards = [];

    try {
      await sendBatchCard(batch, executor);
    } catch (error) {
      console.error("[deleted-message-audit] Failed to send bulk deletion notification:", error);
    }
  }

  function scheduleBatch(batch: DeleteBatch, executor: Executor) {
    const nextMinute = (batch.minuteBucket + 1) * AUDIT_MINUTE_MS;
    const delay = Math.max(0, nextMinute - Date.now() + AUDIT_GRACE_MS);
    batch.finalizeTimer = setTimeout(() => void finalizeBatch(batch, executor), delay);
  }

  async function addToBatch(
    deletedMessages: DeletedMessage[],
    executor: Executor,
    showSingleCard: boolean,
  ) {
    const firstMessage = deletedMessages[0];
    if (!firstMessage) return;

    const minuteBucket = Math.floor(firstMessage.deletedAt / 60_000);
    const key = batchKey(firstMessage.guildId, executor.id, minuteBucket);
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        key,
        guildId: firstMessage.guildId,
        executorId: executor.id,
        minuteBucket,
        messages: [],
        cards: [],
        finalizeTimer: setTimeout(() => undefined, 0),
      };
      batches.set(key, batch);
      clearTimeout(batch.finalizeTimer);
      scheduleBatch(batch, executor);
    }

    const wasEmpty = batch.messages.length === 0;
    batch.messages.push(...deletedMessages);

    if (batch.messages.length > 1 && batch.cards.length) {
      await Promise.all(batch.cards.map((card) => card.delete().catch(() => undefined)));
      batch.cards = [];
    }

    if (wasEmpty && deletedMessages.length === 1 && showSingleCard) {
      try {
        const cards = await sendSingleCard(firstMessage, executor);
        if (batches.get(key) === batch && batch.messages.length === 1) {
          batch.cards = cards;
        } else {
          await Promise.all(cards.map((card) => card.delete().catch(() => undefined)));
        }
      } catch (error) {
        console.error("[deleted-message-audit] Failed to send deletion notification:", error);
      }
    }
  }

  function preferredExecutors(guildId: string, minuteBucket: number) {
    return new Set(
      [...batches.values()]
        .filter((batch) => batch.guildId === guildId && batch.minuteBucket === minuteBucket)
        .map((batch) => batch.executorId),
    );
  }

  async function processDeletedMessage(deleted: DeletedMessage) {
    if (deleted.authorId === client.user.id) return;

    const guild = client.guilds.cache.get(deleted.guildId);
    if (!guild) return;

    const minuteBucket = Math.floor(deleted.deletedAt / 60_000);
    const result = await findAuditEntry(
      guild,
      deleted,
      AuditLogEvent.MessageDelete,
      preferredExecutors(deleted.guildId, minuteBucket),
      usedAuditEntries,
      auditStartedAt,
      1,
    );
    try {
      await onDeletion(deleted, result);
    } catch (error) {
      console.error("[ghost-ping] Failed to send notification:", error);
    }
    const executor = result.status === "matched" ? result.entry.executor : null;
    if (!executor || executor.id === deleted.authorId) return;
    const executorMember = guild.members.cache.get(executor.id) ?? await guild.members.fetch(executor.id);
    if (config.ignoredDeletionRoleIds.some((id) => executorMember.roles.cache.has(id))) return;

    await addToBatch([deleted], executor, true);
  }

  async function processBulkDeletedMessages(deletedMessages: DeletedMessage[]) {
    const firstMessage = deletedMessages[0];
    if (!firstMessage) return;

    const guild = client.guilds.cache.get(firstMessage.guildId);
    if (!guild) return;

    const minuteBucket = Math.floor(firstMessage.deletedAt / 60_000);
    const result = await findAuditEntry(
      guild,
      firstMessage,
      AuditLogEvent.MessageBulkDelete,
      preferredExecutors(firstMessage.guildId, minuteBucket),
      usedAuditEntries,
      auditStartedAt,
      deletedMessages.length,
    );
    const executor = result.status === "matched" ? result.entry.executor : null;
    if (!executor) return;
    const executorMember = guild.members.cache.get(executor.id) ?? await guild.members.fetch(executor.id);
    if (config.ignoredDeletionRoleIds.some((id) => executorMember.roles.cache.has(id))) return;

    const otherUsersMessages = deletedMessages.filter((deleted) => deleted.authorId !== executor.id);
    if (!otherUsersMessages.length) return;

    await addToBatch(otherUsersMessages, executor, false);
  }

  client.on(Events.MessageCreate, (message) => {
    rememberMessage(cache, message);
  });
  client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
    rememberMessage(cache, newMessage, true);
  });

  client.on(Events.MessageDelete, (message) => {
    if (ownAuditMessageIds.delete(message.id)) return;
    const deleted = getDeletedMessage(cache, message);
    if (!deleted || deleted.guildId !== adminChannel.guildId) return;
    auditQueue = auditQueue
      .then(() => processDeletedMessage(deleted))
      .catch((error: unknown) => console.error("[deleted-message-audit]", error));
  });
  client.on(Events.MessageBulkDelete, (messages) => {
    const deletedMessages = [...messages.values()]
      .map((message) => {
        if (ownAuditMessageIds.delete(message.id)) return null;
        const deleted = getDeletedMessage(cache, message);
        return deleted && deleted.guildId === adminChannel.guildId && deleted.authorId !== client.user.id
          ? deleted
          : null;
      })
      .filter((deleted): deleted is DeletedMessage => deleted !== null);
    auditQueue = auditQueue
      .then(() => processBulkDeletedMessages(deletedMessages))
      .catch((error: unknown) => console.error("[deleted-message-audit]", error));
  });
}
