/**
 * Deterministic, locale-independent lexicographic order for GitHub logins.
 *
 * Used wherever metrics and facts need a stable tiebreak so the same inputs
 * always sort the same way (and produce the same fact ids). Kept as a plain
 * code-unit comparison on purpose: `localeCompare` is locale-dependent and
 * would make sort order vary by machine.
 */
export function compareLogin(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
