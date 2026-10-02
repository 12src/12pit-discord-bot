export const config = {
  token: process.env.DISCORD_TOKEN?.trim() ?? "",
  githubRepository: "12src/12pit",
  githubReferences: {
    categoryId: "1554044416929562674",
  },
  ignoredDeletionRoleIds: [
    "1553770934601781300",
    "1553774146339733564",
  ],
  messageCache: {
    ttlMs: 60 * 60 * 1_000,
    maxSize: 10_000,
  },
  deletedMessageAudit: {
    graceMs: 5 * 1_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
    fetchLimit: 25,
    color: 0xed4245,
  },
  ghostPing: {
    windowMs: 60 * 1_000,
    color: 0xfee75c,
  },
  channels: {
    joinLeave: "1554043288963784835",
    rules: "1553759799613853739",
    admin: "1553759800053989498",
  },
} as const;
