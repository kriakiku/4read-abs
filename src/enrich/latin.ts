/** True when most letters in the string are Latin script (English series names, etc.). */
export function isMostlyLatin(value: string): boolean {
  const letters = [...value].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= 0.75;
}

/** Pull a leading integer sequence from series_seq ("1", "1.5", "01"). */
export function parseSequenceNumber(sequence: string | null | undefined): number | null {
  if (!sequence) return null;
  const match = sequence.trim().match(/^(\d+)(?:[.,]\d+)?$/);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const UK_ORDINALS: Array<[RegExp, number]> = [
  [/(?<![\p{L}\p{N}])перш(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 1],
  [/(?<![\p{L}\p{N}])друг(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 2],
  [/(?<![\p{L}\p{N}])трет(ій|я|є|ього)(?![\p{L}\p{N}])/iu, 3],
  [/(?<![\p{L}\p{N}])четверт(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 4],
  [/(?<![\p{L}\p{N}])п['’ʼ]?ят(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 5],
  [/(?<![\p{L}\p{N}])шост(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 6],
  [/(?<![\p{L}\p{N}])сьом(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 7],
  [/(?<![\p{L}\p{N}])восьм(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 8],
  [/(?<![\p{L}\p{N}])дев['’ʼ]?ят(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 9],
  [/(?<![\p{L}\p{N}])десят(ий|а|е|ого)(?![\p{L}\p{N}])/iu, 10],
];

const EN_YEAR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseYearToken(token: string): number | null {
  const lower = token.toLowerCase();
  if (EN_YEAR_WORDS[lower]) return EN_YEAR_WORDS[lower]!;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Guess a volume/year index from a Ukrainian or English title when series_seq is missing
 * ("Перший рік", "Year Two", "Volume 3").
 */
export function inferVolumeHint(title: string): number | null {
  for (const [pattern, value] of UK_ORDINALS) {
    if (pattern.test(title)) return value;
  }
  const english = title.match(
    /\b(?:year|volume|vol\.?|book|part)\s*(?:#|№)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  if (!english) return null;
  return parseYearToken(english[1]!);
}

export interface YearRange {
  from: number;
  to: number;
}

/**
 * Some English edition titles pack several Hogwarts years into one volume, e.g.
 * "All The Young Dudes - Volume Two: Years 5 - 7".
 */
export function parseYearRange(title: string): YearRange | null {
  const range = title.match(
    /\byears?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*[-–—to]+\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  if (range) {
    const from = parseYearToken(range[1]!);
    const to = parseYearToken(range[2]!);
    if (from && to && to >= from) return { from, to };
  }

  const single = title.match(
    /\byear\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  if (single) {
    const n = parseYearToken(single[1]!);
    if (n) return { from: n, to: n };
  }
  return null;
}

export function yearRangeContains(range: YearRange, year: number): boolean {
  return year >= range.from && year <= range.to;
}
