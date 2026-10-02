import {
  ContainerBuilder,
  FileBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";

type ReportCardOptions = {
  title: string;
  color: number;
  authorLabel: string;
  author: string;
  avatarUrl?: string;
  content: string;
  details?: string;
  attachmentName?: string;
};

export function createReportCards(options: ReportCardOptions) {
  const title = `# ${options.title}`;
  const author = `**${options.authorLabel}**\n${options.author}`;
  const content = options.content || "No text available.";
  const contentLimit = 4_000 - title.length - author.length - (options.details?.length ?? 0);
  const cards: ContainerBuilder[] = [];

  for (let start = 0; start < content.length;) {
    let end = Math.min(start + contentLimit, content.length);
    if (end < content.length) {
      const breakAt = Math.max(content.lastIndexOf("\n", end - 1), content.lastIndexOf(" ", end - 1));
      if (breakAt > start + contentLimit / 2) end = breakAt + 1;
      const tagStart = content.lastIndexOf("<", end - 1);
      if (tagStart > start && content.indexOf(">", tagStart) >= end) end = tagStart;
      if (/[\uD800-\uDBFF]/.test(content[end - 1]!)) end -= 1;
    }

    const card = new ContainerBuilder()
      .setAccentColor(options.color)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
    const authorText = new TextDisplayBuilder().setContent(author);
    if (options.avatarUrl) {
      card.addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(authorText)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(options.avatarUrl)));
    } else {
      card.addTextDisplayComponents(authorText);
    }
    card.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(start, end)));
    if (options.details) {
      card.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(options.details));
    }
    if (options.attachmentName) {
      card.addFileComponents(new FileBuilder().setURL(`attachment://${options.attachmentName}`));
    }
    cards.push(card);
    start = end;
  }

  return cards;
}
