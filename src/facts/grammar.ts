import { FACT_KINDS, type FactKind } from "./types.js";

/**
 * The one place the citeable-fact id grammar is minted: `fact:<kind>:<subject>`.
 *
 * The backend stamps this onto every fact (facts/build.ts) and the SPA stamps the same id onto the
 * table cell each fact cites (InsightTables), so the evidence chip → cell link is `getElementById`.
 * Both sides import these helpers, so the id and every per-kind subject format have a single
 * definition and cannot drift. This module is dep-clean (only ./types), so the web bundles it safely.
 */
export function factId(kind: FactKind, subject: string): string {
  return `fact:${kind}:${subject}`;
}

// --- Subject formats for the kinds that have a table cell to link to. Defined once, used by both
// the fact builder and the cell renderer. ---

/** Leaderboard cell: which board, then the login. */
export function leaderboardSubject(board: string, login: string): string {
  return `${board}:${login}`;
}

/** Rubber-stamp rate for one reviewer. */
export function rubberStampReviewerSubject(login: string): string {
  return login;
}

/** Rubber-stamp rate for a reviewer → author pair. */
export function rubberStampPairSubject(reviewer: string, author: string): string {
  return `${reviewer}->${author}`;
}

/** Which statistic in a cycle-time interval row a cell holds. */
export type CycleStat = "n" | "p50" | "p75";

/** Cycle-time cell: an interval key plus which statistic. */
export function cycleTimeSubject(interval: string, stat: CycleStat): string {
  return `${interval}_${stat}`;
}

/** Fact kinds whose facts have a rendered table cell, so their chips become links (Q52). */
export const LINKABLE_FACT_KINDS: ReadonlySet<FactKind> = new Set<FactKind>([
  "leaderboard",
  "rubberstamp",
  "cycletime",
]);

const ID_PATTERN = /^fact:([a-z]+):.+$/;

/** The kind segment of a fact id, or null when the string is not a fact id. */
export function factKindOf(id: string): FactKind | null {
  const kind = ID_PATTERN.exec(id)?.[1];
  return kind !== undefined && (FACT_KINDS as readonly string[]).includes(kind)
    ? (kind as FactKind)
    : null;
}

/** True when a fact id points at a citeable table cell. Derived from the kind, not an ad-hoc regex. */
export function isTableFactId(id: string): boolean {
  const kind = factKindOf(id);
  return kind !== null && LINKABLE_FACT_KINDS.has(kind);
}
