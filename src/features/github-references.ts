import { Events, type Client } from "discord.js";
import { config } from "../config.ts";

type GithubIssue = {
  html_url: string;
  pull_request?: { html_url?: string };
};

export function registerGithubReferences(client: Client<true>, guildId: string) {
  const repository = config.githubRepository;
  const pending = new Map<string, Promise<string | null>>();
  let blockedUntil = 0;

  async function fetchLink(number: string): Promise<string | null> {
    if (Date.now() < blockedUntil) return null;

    const response = await fetch(
      `https://api.github.com/repos/${repository}/issues/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "12pit-discord-bot",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (response.status === 404 || response.status === 410) return null;

    if (response.status === 403 || response.status === 429) {
      const retryAfter = Math.max(1, Number(response.headers.get("retry-after")) || 60);
      const resetAt = (Number(response.headers.get("x-ratelimit-reset")) || 0) * 1_000;
      blockedUntil = Math.max(
        Date.now() + retryAfter * 1_000,
        response.headers.get("x-ratelimit-remaining") === "0" ? resetAt : 0,
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status} for #${number}.`);
    }

    const issue = (await response.json()) as GithubIssue;
    const url = issue.pull_request?.html_url ?? issue.html_url;
    const base = `https://github.com/${repository}`;

    return url === `${base}/issues/${number}` || url === `${base}/pull/${number}`
      ? url
      : null;
  }

  function getLink(number: string): Promise<string | null> {
    const existing = pending.get(number);
    if (existing) return existing;

    const request = fetchLink(number)
      .catch((error: unknown) => {
        console.error(`[github-references] Lookup failed for #${number}:`, error);
        return null;
      })
      .finally(() => pending.delete(number));

    pending.set(number, request);
    return request;
  }

  client.on(Events.MessageCreate, async (message) => {
    if (
      !message.inGuild() ||
      message.guildId !== guildId ||
      message.author.bot ||
      message.webhookId
    ) return;

    const channel = message.channel;
    const categoryId = channel.isThread() ? channel.parent?.parentId : channel.parentId;
    if (categoryId !== config.githubReferences.categoryId) return;
    if (!channel.isSendable()) return;

    const numbers = new Set([...message.content.matchAll(/#([1-9]\d*)/g)].map((match) => match[1]!));
    for (const number of numbers) {
      try {
        const url = await getLink(number);
        if (!url) continue;

        await channel.send({ content: url, allowedMentions: { parse: [] } });
      } catch (error) {
        console.error(`[github-references] Failed to send link for #${number}:`, error);
      }
    }
  });
}
