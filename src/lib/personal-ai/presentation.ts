const emojiSequencePattern = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*)/gu;

export function formatValResponse(content: string) {
  let text = content.replace(/\r\n?/g, "\n").trim();
  const hasLegacyMarkdown = /\*\*|__|^\s{0,3}#{1,6}\s/m.test(text);
  const inlineListCount = text.match(/[ \t]+-[ \t]+(?=\S)/g)?.length ?? 0;

  text = text.replace(/(^|[ \t])\*\*([^*\n]{1,100}:)\*\*[ \t]*/g, (_match, prefix: string, heading: string) =>
    `${prefix ? "\n\n" : ""}${heading.trim()}\n`,
  );
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "");

  if (hasLegacyMarkdown && inlineListCount >= 2) {
    text = text.replace(/[ \t]+-[ \t]+(?=\S)/g, "\n• ");
  }

  text = text
    .replace(/(^|\n)[ \t]*[-*][ \t]+/gm, "$1• ")
    .replace(/(^|\n)[ \t]*(\d+)[.)][ \t]+/gm, "$1$2. ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let emojiCount = 0;
  text = text.replace(emojiSequencePattern, (emoji) => {
    emojiCount += 1;
    return emojiCount === 1 ? emoji : "";
  });
  return text.replace(/•[ \t]{2,}/g, "• ").replace(/\n{3,}/g, "\n\n").trim();
}
