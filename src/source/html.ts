import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "blockquote",
  "section",
]);

/**
 * Text extraction that respects line breaks. Cheerio's `.text()` glues paragraphs that are
 * separated only by `<br>`, which mangles descriptions on this source.
 */
export function htmlToText($: CheerioAPI, node: AnyNode | undefined): string {
  if (!node) return "";
  const out: string[] = [];

  const walk = (current: AnyNode): void => {
    if (current.type === "text") {
      out.push((current as unknown as { data: string }).data);
      return;
    }
    if (current.type !== "tag" && current.type !== "script" && current.type !== "style") {
      const children = (current as unknown as { children?: AnyNode[] }).children ?? [];
      for (const child of children) walk(child);
      return;
    }
    const tag = (current as unknown as { tagName: string }).tagName?.toLowerCase();
    if (tag === "script" || tag === "style") return;
    const isBlock = tag ? BLOCK_TAGS.has(tag) : false;
    if (isBlock) out.push("\n");
    const children = (current as unknown as { children?: AnyNode[] }).children ?? [];
    for (const child of children) walk(child);
    if (isBlock) out.push("\n");
  };

  walk(node);
  void $;

  return out
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .trim();
}

/** Support links, donation prompts and player callouts that are not part of the synopsis. */
const NOISE_PATTERNS = [
  /підтрим/i,
  /подякувати/i,
  /buymeacoffee/i,
  /patreon/i,
  /монобанк/i,
  /mono\.?bank/i,
  /телеграм/i,
  /telegram/i,
  /\bдонат/i,
  /слухати аудіокнигу/i,
  /на плеєрі/i,
  /на youtube/i,
  /поділись з друзями/i,
  /приват/i,
  /^\$/,
];

export function stripNoiseLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return true;
      return !NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
