import { useQuery } from "@tanstack/react-query";
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

function exact(value: number | null): string {
  return value === null ? "null" : String(value);
}

function factId(kind: string, subject: string): string {
  return `fact:${kind}:${subject}`;
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
    return <p data-status="error">{errorMessage(insights.error)}</p>;
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
    <section aria-label="Insights">
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
              subject: row.reviewer.login,
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
              subject: `${row.reviewer.login}->${row.author.login}`,
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
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Login</th>
          <th scope="col">{countHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={2}>None in this window.</td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.githubId}>
              <td>{row.login}</td>
              <td id={factId("leaderboard", `${factBoard}:${row.login}`)}>{exact(row.count)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function RateTable({
  caption,
  rows,
}: {
  caption: string;
  rows: readonly {
    key: string;
    label: string;
    subject: string;
    flagged: number;
    eligible: number;
    rate: number | null;
  }[];
}) {
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Who</th>
          <th scope="col">Flagged</th>
          <th scope="col">Eligible</th>
          <th scope="col">Rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4}>None in this window.</td>
          </tr>
        ) : (
          rows.map((row) => (
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
              <td id={factId("cycletime", `${interval.key}_n`)}>{exact(stats.count)}</td>
              <td id={factId("cycletime", `${interval.key}_p50`)}>{exact(stats.median)}</td>
              <td id={factId("cycletime", `${interval.key}_p75`)}>{exact(stats.p75)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
