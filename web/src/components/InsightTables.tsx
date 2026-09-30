import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cycleTimeSubject,
  factId,
  leaderboardSubject,
  rubberStampPairSubject,
  rubberStampReviewerSubject,
} from "../../../src/facts/grammar.js";
import { api, type ApiClient, type InsightsResponse, type WindowQuery } from "../api/client.js";
import { insightsQuery } from "../api/queries.js";

export type InsightTablesProps = {
  client?: ApiClient;
  /** The window QueryControls just submitted. Null until the first sync succeeds. */
  window: WindowQuery | null;
};

type LeaderboardRow = InsightsResponse["leaderboards"]["reviewers"][number];
type CycleStats = InsightsResponse["cycleTime"]["readyToFirstReview"];

const BOARDS: readonly {
  key: keyof InsightsResponse["leaderboards"];
  caption: string;
  countHeader: string;
}[] = [
  { key: "reviewers", caption: "Top reviewers", countHeader: "Reviews" },
  { key: "authors", caption: "Top authors", countHeader: "Pull requests" },
  // Label reads "shippers" not "closers": the number is who authored the merged PR (who landed
  // the work), not who pressed merge. GitHub's merger login is not stored. See leaderboards.ts.
  { key: "closers", caption: "Top shippers", countHeader: "Merged pull requests" },
];

const INTERVALS: readonly {
  key: "first_review" | "review_to_approval" | "approval_to_merge";
  label: string;
  stats: (cycle: InsightsResponse["cycleTime"]) => CycleStats;
}[] = [
  {
    key: "first_review",
    label: "Ready to first review",
    stats: (cycle) => cycle.readyToFirstReview,
  },
  {
    key: "review_to_approval",
    label: "First review to first approval",
    stats: (cycle) => cycle.firstReviewToFirstApproval,
  },
  {
    key: "approval_to_merge",
    label: "First approval to merge",
    stats: (cycle) => cycle.firstApprovalToMerge,
  },
];

/** Rows shown per leaderboard before "See More" is used. Repos with many contributors would
 * otherwise render an unbounded table. */
const COLLAPSED_ROWS = 5;

function exact(value: number | null): string {
  return value === null ? "null" : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Request failed";
}

function isEmpty(data: InsightsResponse): boolean {
  const boardsEmpty = BOARDS.every((board) => data.leaderboards[board.key].length === 0);
  const ratesEmpty = data.rubberStamp.reviewers.length === 0 && data.rubberStamp.pairs.length === 0;
  const cycleEmpty = INTERVALS.every((interval) => interval.stats(data.cycleTime).count === 0);
  return boardsEmpty && ratesEmpty && cycleEmpty;
}

export function InsightTables({ client = api, window }: InsightTablesProps) {
  const insights = useQuery({
    ...insightsQuery(client, window ?? { owner: "pending", repo: "pending" }),
    enabled: window !== null,
  });

  if (window === null) {
    return <p role="status">Sync a repository to load insight tables.</p>;
  }
  if (insights.isError) {
    // role="alert" so a screen reader announces the failure; the "Error:" prefix is a non-color
    // cue so the message does not rely on the rose color alone (Decisions Q46).
    return (
      <p role="alert" data-status="error">
        Error: {errorMessage(insights.error)}
      </p>
    );
  }
  if (!insights.data) {
    return (
      <p role="status" aria-busy="true">
        Loading insights…
      </p>
    );
  }

  const data = insights.data;
  return (
    <section aria-labelledby="insights-heading">
      <h2 id="insights-heading">Insights</h2>
      <p>
        {data.window.owner}/{data.window.repo} · {data.window.since}–{data.window.until}
      </p>
      {isEmpty(data) ? (
        <p role="status">No review activity in this window.</p>
      ) : (
        <div className="tables">
          <h2>Leaderboards</h2>
          {BOARDS.map((board) => (
            <Leaderboard
              key={board.key}
              caption={board.caption}
              countHeader={board.countHeader}
              factBoard={board.key}
              rows={data.leaderboards[board.key]}
            />
          ))}
          <h2>Rubber-stamp rates</h2>
          <p>
            Fast approval under {data.rubberStamp.fastApprovalSeconds}s. Minimum PR size{" "}
            {data.rubberStamp.minPrSize} lines.
          </p>
          <RateTable
            caption="Rubber-stamp rates by reviewer"
            rows={data.rubberStamp.reviewers.map((row) => ({
              key: String(row.reviewer.githubId),
              label: row.reviewer.login,
              subject: rubberStampReviewerSubject(row.reviewer.login),
              flagged: row.flagged,
              eligible: row.eligible,
              rate: row.rate,
            }))}
          />
          <RateTable
            caption="Rubber-stamp rates by pair"
            rows={data.rubberStamp.pairs.map((row) => ({
              key: `${row.reviewer.githubId}->${row.author.githubId}`,
              label: `${row.reviewer.login} → ${row.author.login}`,
              subject: rubberStampPairSubject(row.reviewer.login, row.author.login),
              flagged: row.flagged,
              eligible: row.eligible,
              rate: row.rate,
            }))}
          />
          <h2>Cycle time</h2>
          <p>Seconds. Median is p50. Null means that interval had no merged pull request.</p>
          <CycleTime cycle={data.cycleTime} />
        </div>
      )}
    </section>
  );
}

function Leaderboard({
  caption,
  countHeader,
  factBoard,
  rows,
}: {
  caption: string;
  countHeader: string;
  factBoard: string;
  rows: readonly LeaderboardRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();

  const collapsible = rows.length > COLLAPSED_ROWS;
  const visibleRows = collapsible && !expanded ? rows.slice(0, COLLAPSED_ROWS) : rows;

  return (
    <div className="board">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Login</th>
            <th scope="col">{countHeader}</th>
          </tr>
        </thead>
        <tbody id={bodyId}>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={2}>None in this window.</td>
            </tr>
          ) : (
            visibleRows.map((row) => (
              <tr key={row.githubId}>
                <td>{row.login}</td>
                <td id={factId("leaderboard", leaderboardSubject(factBoard, row.login))}>
                  {exact(row.count)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {collapsible ? (
        <button
          type="button"
          className="see-more"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "See Less" : "See More"}
        </button>
      ) : null}
    </div>
  );
}

type RateRow = {
  key: string;
  label: string;
  subject: string;
  flagged: number;
  eligible: number;
  rate: number | null;
};

type SortKey = "who" | "flagged" | "eligible" | "rate";
type SortDirection = "asc" | "desc";
type SortState = { key: SortKey; direction: SortDirection };

// What each rubber-stamp column counts, mirroring the backend detectRubberStamps logic. The
// description is shown as a hover/focus tooltip and read out by screen readers (see ColumnHeader).
// Thresholds are stated in the visible line above the tables ("Fast approval under Ns…"). Each
// column is also click-to-sort; numeric columns lead with the largest value, text with A–Z.
const RATE_COLUMNS: readonly {
  key: SortKey;
  label: string;
  numeric: boolean;
  description?: string;
}[] = [
  { key: "who", label: "Who", numeric: false },
  {
    key: "flagged",
    label: "Flagged",
    numeric: true,
    description:
      "Eligible approvals that look like rubber-stamps: faster than the fast-approval threshold, with no review comment from that reviewer, on a pull request larger than the minimum size. All three are required.",
  },
  {
    key: "eligible",
    label: "Eligible",
    numeric: true,
    description:
      "Approvals counted as the denominator: APPROVED reviews of someone else's pull request with a valid (non-negative) time to approval. Pull request size does not affect eligibility.",
  },
  {
    key: "rate",
    label: "Rate",
    numeric: true,
    description: "Flagged divided by Eligible. Shown as null when there are no eligible approvals.",
  },
];

/** Sort a copy of the rows by one column. Array.sort is stable, so ties keep the order the API
 * returned (eligible descending). A null rate always sinks to the bottom, either direction. */
function sortRows(rows: readonly RateRow[], sort: SortState): RateRow[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (sort.key === "who") {
      return left.label.localeCompare(right.label) * factor;
    }
    if (sort.key === "rate") {
      if (left.rate === null && right.rate === null) return 0;
      if (left.rate === null) return 1;
      if (right.rate === null) return -1;
      return (left.rate - right.rate) * factor;
    }
    return (left[sort.key] - right[sort.key]) * factor;
  });
}

/**
 * A sortable rubber-stamp column header. The label sits in one button that sorts the table by that
 * column (toggling direction on repeat clicks). When the column has a description, a separate info
 * icon button carries the tooltip — and it is the ONLY thing that opens it, on hover, keyboard focus
 * or click (Escape dismisses it), so sorting never triggers the tooltip. The tooltip is
 * position:fixed to escape the table's `overflow: hidden` clip, and stays in the DOM referenced by
 * aria-describedby so assistive tech reads it. `aria-sort` on the cell reports the sort state.
 */
function ColumnHeader({
  column,
  sort,
  onSort,
}: {
  column: (typeof RATE_COLUMNS)[number];
  sort: SortState | null;
  onSort: (column: (typeof RATE_COLUMNS)[number]) => void;
}) {
  const tipId = useId();
  const iconRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const active = sort?.key === column.key;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  const hasTip = column.description !== undefined;

  function show() {
    const el = iconRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setCoords({ left: rect.left + rect.width / 2, top: rect.bottom });
    }
    setOpen(true);
  }

  return (
    <th scope="col" aria-sort={ariaSort}>
      <span className="col-header">
        <button type="button" className="col-sort" onClick={() => onSort(column)}>
          <span>{column.label}</span>
          <span className="col-sort-arrow" aria-hidden="true">
            {active ? (sort.direction === "asc" ? "▲" : "▼") : ""}
          </span>
        </button>
        {hasTip ? (
          <button
            ref={iconRef}
            type="button"
            className="col-info"
            aria-label={`About ${column.label}`}
            aria-describedby={tipId}
            onMouseEnter={show}
            onMouseLeave={() => setOpen(false)}
            onFocus={show}
            onBlur={() => setOpen(false)}
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            <svg
              className="col-info-icon"
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 16 16"
              width="13"
              height="13"
            >
              <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
              <path
                d="M8 7v4.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </span>
      {hasTip ? (
        <span
          id={tipId}
          role="tooltip"
          className="tooltip"
          data-open={open}
          style={{ left: coords.left, top: coords.top }}
        >
          {column.description}
        </span>
      ) : null}
    </th>
  );
}

function RateTable({ caption, rows }: { caption: string; rows: readonly RateRow[] }) {
  const [expanded, setExpanded] = useState(false);
  // Null keeps the order the API returned (eligible descending) until the user picks a column.
  const [sort, setSort] = useState<SortState | null>(null);
  const bodyId = useId();

  function toggleSort(column: (typeof RATE_COLUMNS)[number]): void {
    setSort((current) =>
      current?.key === column.key
        ? { key: column.key, direction: current.direction === "asc" ? "desc" : "asc" }
        : // First click leads with the most useful end: largest for counts/rate, A–Z for names.
          { key: column.key, direction: column.numeric ? "desc" : "asc" },
    );
  }

  const ordered = sort ? sortRows(rows, sort) : rows;
  const collapsible = ordered.length > COLLAPSED_ROWS;
  const visibleRows = collapsible && !expanded ? ordered.slice(0, COLLAPSED_ROWS) : ordered;

  return (
    <div className="board">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {RATE_COLUMNS.map((column) => (
              <ColumnHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
            ))}
          </tr>
        </thead>
        <tbody id={bodyId}>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>None in this window.</td>
            </tr>
          ) : (
            visibleRows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{exact(row.flagged)}</td>
                <td>{exact(row.eligible)}</td>
                <td id={factId("rubberstamp", row.subject)}>{exact(row.rate)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {collapsible ? (
        <button
          type="button"
          className="see-more"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "See Less" : "See More"}
        </button>
      ) : null}
    </div>
  );
}

function CycleTime({ cycle }: { cycle: InsightsResponse["cycleTime"] }) {
  return (
    <table>
      <caption>Cycle time</caption>
      <thead>
        <tr>
          <th scope="col">Interval</th>
          <th scope="col">Count</th>
          <th scope="col">Median (seconds)</th>
          <th scope="col">p75 (seconds)</th>
        </tr>
      </thead>
      <tbody>
        {INTERVALS.map((interval) => {
          const stats = interval.stats(cycle);
          return (
            <tr key={interval.key}>
              <td>{interval.label}</td>
              <td id={factId("cycletime", cycleTimeSubject(interval.key, "n"))}>
                {exact(stats.count)}
              </td>
              <td id={factId("cycletime", cycleTimeSubject(interval.key, "p50"))}>
                {exact(stats.median)}
              </td>
              <td id={factId("cycletime", cycleTimeSubject(interval.key, "p75"))}>
                {exact(stats.p75)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
