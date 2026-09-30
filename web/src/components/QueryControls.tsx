import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  api,
  type ApiClient,
  type SyncRequest,
  type SyncResponse,
  type WindowQuery,
} from "../api/client.js";
import { insightsQuery, reposQuery, syncMutationOptions } from "../api/queries.js";
import { RepoPicker } from "./RepoPicker.js";
import {
  dateRangeBlockReason,
  defaultUtcDateRange,
  resolveUtcDateRange,
  splitOwnerRepo,
} from "./range.js";

export type QueryControlsProps = {
  client?: ApiClient;
  /** Milliseconds since the epoch. Used once to seed the date picker. */
  now?: () => number;
  /**
   * The window written to `['insights', window]`. Null while a sync is in flight
   * and until the first sync succeeds, so tables do not keep the previous repo.
   */
  onWindowChange?: (window: WindowQuery | null) => void;
};

type StatusKind = "idle" | "pending" | "error" | "success";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Request failed";
}

function successText(result: SyncResponse): string {
  return `Synced ${result.prCount} pull requests and ${result.reviewCount} reviews. Insights loaded.`;
}

export function QueryControls({
  client = api,
  now = Date.now,
  onWindowChange,
}: QueryControlsProps) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [dates, setDates] = useState(() => defaultUtcDateRange(now()));
  const [submitted, setSubmitted] = useState<WindowQuery | null>(null);
  const repos = useQuery(reposQuery(client));
  const sync = useMutation(syncMutationOptions(client));
  const insights = useQuery({
    ...insightsQuery(client, submitted ?? { owner: "pending", repo: "pending" }),
    enabled: submitted !== null,
  });

  const resolved = resolveUtcDateRange(dates);
  const blockReason = dateRangeBlockReason(dates);
  const busy = sync.isPending || (submitted !== null && insights.isFetching);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resolved) return;
    const { owner, repo } = splitOwnerRepo(slug);
    const body: SyncRequest = {
      owner,
      repo,
      since: resolved.since,
      until: resolved.until,
    };
    setSubmitted(null);
    onWindowChange?.(null);
    try {
      await sync.mutateAsync(body);
    } catch {
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["insights", body] });
    await queryClient.invalidateQueries({ queryKey: ["insights", "graph", body] });
    setSubmitted(body);
    onWindowChange?.(body);
  }

  const status = statusFor({
    blockReason,
    syncPending: sync.isPending,
    syncError: sync.isError ? errorMessage(sync.error) : null,
    insightsFetching: submitted !== null && insights.isFetching,
    insightsError: submitted !== null && insights.isError ? errorMessage(insights.error) : null,
    insightsLoaded: submitted !== null && insights.isSuccess && !insights.isFetching,
    syncResult: sync.data ?? null,
  });

  // A date-range block surfaces as the "idle" status; a failed submit as "error". Point the
  // offending field's aria-describedby at the one status <p> and mark it aria-invalid (M9).
  const dateInvalid = status?.kind === "idle";
  const slugInvalid = status?.kind === "error";
  const statusId = "query-status";

  return (
    <form onSubmit={onSubmit} aria-busy={busy}>
      <RepoPicker
        repos={repos.data ?? []}
        status={repos.status}
        errorMessage={repos.error instanceof Error ? repos.error.message : undefined}
        slug={slug}
        onSlugChange={setSlug}
        disabled={busy}
        slugInvalid={slugInvalid}
        slugDescribedById={statusId}
      />
      <fieldset disabled={busy}>
        <legend>Date range (UTC)</legend>
        <label htmlFor="since-date">
          Since
          <input
            id="since-date"
            type="date"
            value={dates.since}
            aria-invalid={dateInvalid}
            aria-describedby={dateInvalid ? statusId : undefined}
            onChange={(event) => {
              const since = event.target.value;
              setDates((current) => ({ ...current, since }));
            }}
          />
        </label>
        <label htmlFor="until-date">
          Until
          <input
            id="until-date"
            type="date"
            value={dates.until}
            aria-invalid={dateInvalid}
            aria-describedby={dateInvalid ? statusId : undefined}
            onChange={(event) => {
              const until = event.target.value;
              setDates((current) => ({ ...current, until }));
            }}
          />
        </label>
      </fieldset>
      <button type="submit" disabled={resolved === null || busy}>
        Sync
      </button>
      {status ? (
        <p
          id={statusId}
          role={status.kind === "error" ? "alert" : "status"}
          data-status={status.kind}
        >
          {status.text}
        </p>
      ) : null}
    </form>
  );
}

function statusFor(input: {
  blockReason: string | null;
  syncPending: boolean;
  syncError: string | null;
  insightsFetching: boolean;
  insightsError: string | null;
  insightsLoaded: boolean;
  syncResult: SyncResponse | null;
}): { kind: StatusKind; text: string } | null {
  if (input.syncPending) return { kind: "pending", text: "Syncing…" };
  if (input.syncError) return { kind: "error", text: input.syncError };
  if (input.insightsFetching) return { kind: "pending", text: "Loading insights…" };
  if (input.insightsError) return { kind: "error", text: input.insightsError };
  if (input.insightsLoaded && input.syncResult) {
    return { kind: "success", text: successText(input.syncResult) };
  }
  if (input.blockReason) return { kind: "idle", text: input.blockReason };
  return null;
}
