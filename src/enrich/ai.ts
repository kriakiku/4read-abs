import type { Config } from "../config.ts";
import { getMeta, nowIso, setMeta, type Db } from "../db.ts";
import { logger } from "../log.ts";

const log = logger("ai");

export interface AiMatchCandidate {
  index: number;
  title: string;
  authors: string[];
  slug?: string | null;
  seriesPosition?: number | null;
  compilation?: boolean;
}

export interface AiMatchRequest {
  title: string;
  authors: string[];
  seriesName: string | null;
  seriesSeq: string | null;
  candidates: AiMatchCandidate[];
}

export interface AiMatchDecision {
  /** Candidate index, or null when none fit. */
  index: number | null;
  confidence: number;
  reason: string;
  cached: boolean;
}

/**
 * Optional OpenAI-compatible helper for Hardcover disambiguation.
 * Default model is OpenCode Go's cheapest solid option (mimo-v2.5). Calls are capped and
 * cached; only ambiguous heuristic cases should reach this client.
 */
export class AiMatcher {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get enabled(): boolean {
    return this.config.ai.enabled && this.config.ai.apiKey.length > 0;
  }

  private cacheGet(key: string): AiMatchDecision | null {
    const row = this.db
      .query<{ response: string }, [string]>("select response from ai_cache where query_key = ?")
      .get(key);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.response) as AiMatchDecision;
      return { ...parsed, cached: true };
    } catch {
      return null;
    }
  }

  private cacheSet(key: string, value: AiMatchDecision): void {
    this.db
      .query(
        `insert into ai_cache (query_key, response, fetched_at) values (?, ?, ?)
         on conflict(query_key) do update set response = excluded.response, fetched_at = excluded.fetched_at`,
      )
      .run(key, JSON.stringify({ ...value, cached: false }), nowIso());
  }

  private withinBudget(): boolean {
    const now = new Date();
    const dayKey = `ai.calls.day.${now.toISOString().slice(0, 10)}`;
    const hourKey = `ai.calls.hour.${now.toISOString().slice(0, 13)}`;
    const dayCount = Number.parseInt(getMeta(this.db, dayKey) ?? "0", 10) || 0;
    const hourCount = Number.parseInt(getMeta(this.db, hourKey) ?? "0", 10) || 0;
    if (dayCount >= this.config.ai.maxCallsPerDay) {
      log.warn(`AI daily budget exhausted (${dayCount}/${this.config.ai.maxCallsPerDay})`);
      return false;
    }
    if (hourCount >= this.config.ai.maxCallsPerHour) {
      log.warn(`AI hourly budget exhausted (${hourCount}/${this.config.ai.maxCallsPerHour})`);
      return false;
    }
    return true;
  }

  private recordCall(): void {
    const now = new Date();
    const dayKey = `ai.calls.day.${now.toISOString().slice(0, 10)}`;
    const hourKey = `ai.calls.hour.${now.toISOString().slice(0, 13)}`;
    const dayCount = Number.parseInt(getMeta(this.db, dayKey) ?? "0", 10) || 0;
    const hourCount = Number.parseInt(getMeta(this.db, hourKey) ?? "0", 10) || 0;
    setMeta(this.db, dayKey, String(dayCount + 1));
    setMeta(this.db, hourKey, String(hourCount + 1));
  }

  /**
   * Pick the best candidate index for a source book, or null. Returns null without calling the
   * model when disabled, over budget, or when the payload is empty.
   */
  async chooseMatch(request: AiMatchRequest): Promise<AiMatchDecision | null> {
    if (!this.enabled) return null;
    if (request.candidates.length === 0) return null;

    const cacheKey = `match:${Bun.hash(JSON.stringify(request)).toString(16)}`;
    const cached = this.cacheGet(cacheKey);
    if (cached) return cached;
    if (!this.withinBudget()) return null;

    const system = [
      "You match one Ukrainian audiobook listing to an English Hardcover candidate.",
      "Reply with JSON only: {\"index\":number|null,\"confidence\":0-1,\"reason\":\"short\"}.",
      "index is the candidate's index field, or null if none are a 1:1 book match.",
      "Never merge several source volumes into one compilation candidate.",
      "Prefer series position and English series name over transliterated Ukrainian titles.",
      "If a candidate is a compilation spanning multiple years/volumes, return null.",
    ].join(" ");

    const user = JSON.stringify({
      source: {
        title: request.title,
        authors: request.authors,
        series: request.seriesName,
        sequence: request.seriesSeq,
      },
      candidates: request.candidates.map((c) => ({
        index: c.index,
        title: c.title,
        authors: c.authors,
        slug: c.slug ?? null,
        position: c.seriesPosition ?? null,
        compilation: Boolean(c.compilation),
      })),
    });

    const endpoint = `${this.config.ai.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.recordCall();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.ai.apiKey}`,
          "user-agent": "4read-abs (metadata matching)",
        },
        body: JSON.stringify({
          model: this.config.ai.model,
          temperature: 0,
          max_tokens: 120,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        log.warn(`AI match HTTP ${response.status}`);
        return null;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      if (!parsed) {
        log.warn("AI match returned unparseable content");
        return null;
      }

      const index =
        typeof parsed.index === "number" && Number.isInteger(parsed.index)
          ? parsed.index
          : parsed.index === null
            ? null
            : null;
      const valid =
        index === null || request.candidates.some((candidate) => candidate.index === index);
      const decision: AiMatchDecision = {
        index: valid ? index : null,
        confidence: clamp01(Number(parsed.confidence) || 0),
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
        cached: false,
      };
      this.cacheSet(cacheKey, decision);
      return decision;
    } catch (error) {
      log.warn(`AI match failed: ${String(error)}`);
      return null;
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function extractJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]!) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
