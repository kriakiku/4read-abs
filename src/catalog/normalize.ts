const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** Cyrillic to Latin, so titles can be compared against Latin-transliterated library folders. */
const TRANSLIT: Array<[RegExp, string]> = [
  [/щ/g, "shch"],
  [/ш/g, "sh"],
  [/ч/g, "ch"],
  [/ц/g, "ts"],
  [/ю/g, "iu"],
  [/я/g, "ia"],
  [/ї/g, "i"],
  [/є/g, "ie"],
  [/ж/g, "zh"],
  [/х/g, "kh"],
  [/ь/g, ""],
  [/ъ/g, ""],
  [/’/g, ""],
  [/'/g, ""],
  [/а/g, "a"],
  [/б/g, "b"],
  [/в/g, "v"],
  [/г/g, "h"],
  [/ґ/g, "g"],
  [/д/g, "d"],
  [/е/g, "e"],
  [/ё/g, "e"],
  [/з/g, "z"],
  [/и/g, "y"],
  [/і/g, "i"],
  [/й/g, "i"],
  [/к/g, "k"],
  [/л/g, "l"],
  [/м/g, "m"],
  [/н/g, "n"],
  [/о/g, "o"],
  [/п/g, "p"],
  [/р/g, "r"],
  [/с/g, "s"],
  [/т/g, "t"],
  [/у/g, "u"],
  [/ф/g, "f"],
  [/ы/g, "y"],
  [/э/g, "e"],
];

export function transliterate(value: string): string {
  let out = value.toLowerCase();
  for (const [pattern, replacement] of TRANSLIT) out = out.replace(pattern, replacement);
  return out;
}

function romanToArabic(roman: string): number | null {
  const lower = roman.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(lower)) return null;
  let total = 0;
  let previous = 0;
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    const value = ROMAN_VALUES[lower[index]!];
    if (value === undefined) return null;
    total += value < previous ? -value : value;
    previous = Math.max(previous, value);
  }
  return total > 0 && total < 400 ? total : null;
}

function stripPunctuation(value: string): string {
  return value
    .replace(/[’'`ʼ]/g, "")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseName(name: string): string {
  return stripPunctuation(name.toLowerCase());
}

/**
 * Volume markers are written many different ways on this source ("Книга 2", "(Т. 2)",
 * "Частина II"). They are folded into a single `#n` token instead of being dropped, so
 * different volumes of one work stay distinct while different spellings converge.
 */
const VOLUME_PATTERN =
  /\b(?:книга|книжка|кн|том|т|частина|частина|част|ч|part|pt|book|bk|vol|volume)\s*\.?\s*(\d{1,3}|[ivxlcdm]{1,6})(?=\b|$)/giu;

export function normaliseTitle(title: string): string {
  let value = title.toLowerCase().replace(/^\s*аудіокнига\s+/u, "");

  value = value.replace(VOLUME_PATTERN, (_match, group: string) => {
    const arabic = /^\d+$/.test(group) ? Number.parseInt(group, 10) : romanToArabic(group);
    return arabic === null ? " " : ` #${arabic} `;
  });

  value = value.replace(/#\s*(\d{1,3})/g, " #$1 ");

  const normalised = stripPunctuation(value);

  // Collapse repeated volume tokens ("книга 2 #2") down to one.
  const seenVolumes = new Set<string>();
  return normalised
    .split(" ")
    .filter((token) => {
      if (!token.startsWith("#")) return true;
      if (seenVolumes.has(token)) return false;
      seenVolumes.add(token);
      return true;
    })
    .join(" ");
}

export interface WorkIdentity {
  key: string;
  label: string;
}

/**
 * Groups the different readings of the same book. Deliberately excludes the narrator so
 * several narrations collapse onto one work.
 */
export function workIdentity(authorNames: string[], title: string): WorkIdentity {
  const author = authorNames
    .map((name) => normaliseName(name))
    .filter(Boolean)
    .sort()
    .join("&");
  const normalisedTitle = normaliseTitle(title);
  const label = `${author || "?"}|${normalisedTitle}`;
  const key = Bun.hash(label).toString(16);
  return { key, label };
}

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen-Dice over character bigrams: forgiving about word order and small typos. */
export function similarity(left: string, right: string): number {
  const a = left.replace(/\s+/g, "");
  const b = right.replace(/\s+/g, "");
  if (a.length === 0 || b.length === 0) return a === b ? 1 : 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const left2 = bigrams(a);
  const right2 = bigrams(b);
  let overlap = 0;
  for (const [gram, count] of left2) {
    const other = right2.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * Compares a source book with a library item, tolerating both Cyrillic and transliterated
 * spellings. Authors contribute a smaller share than the title.
 */
export function matchScore(
  source: { title: string; authors: string[] },
  candidate: { title: string; authors: string[] },
): number {
  const titleScore = Math.max(
    similarity(normaliseTitle(source.title), normaliseTitle(candidate.title)),
    similarity(transliterate(normaliseTitle(source.title)), transliterate(normaliseTitle(candidate.title))),
  );

  if (source.authors.length === 0 || candidate.authors.length === 0) return titleScore;

  const sourceAuthors = source.authors.map((name) => normaliseName(name));
  const candidateAuthors = candidate.authors.map((name) => normaliseName(name));
  let authorScore = 0;
  for (const one of sourceAuthors) {
    for (const other of candidateAuthors) {
      authorScore = Math.max(
        authorScore,
        similarity(one, other),
        similarity(transliterate(one), transliterate(other)),
      );
    }
  }

  return titleScore * 0.75 + authorScore * 0.25;
}

/** Filesystem-safe folder segment that still reads naturally. */
export function safeFileName(value: string, maxLength = 120): string {
  const cleaned = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  const result = cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
  return result || "untitled";
}
