import { useEffect, useRef, useState } from "react";
import { isTableFactId } from "../../../src/facts/grammar.js";
import { api, type ApiClient, type NarrativeResponse, type WindowQuery } from "../api/client.js";

export type NarrativePanelProps = {
  client?: ApiClient;
  /** The window QueryControls just submitted. Null until the first sync succeeds. */
  window: WindowQuery | null;
};

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NarrativeResponse };

export function exact(value: number | null): string {
  return value === null ? "null" : String(value);
}

/** Mark the table cell this chip cites. A missing cell still leaves the chip as a link. */
export function highlightFact(id: string): void {
  const previous = document.querySelectorAll("[data-cited='true']");
  for (const node of previous) node.removeAttribute("data-cited");
  const target = document.getElementById(id);
  if (!target) return;
  target.setAttribute("data-cited", "true");
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "nearest" });
  }
  // Move focus to the cited cell so the jump is announced, not just scrolled. A table cell is not
  // focusable by default, so make it programmatically focusable first; preventScroll leaves the
  // scrollIntoView above in charge of positioning (Q52).
  target.setAttribute("tabindex", "-1");
  if (typeof target.focus === "function") {
    target.focus({ preventScroll: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Request failed";
}

function windowKey(query: WindowQuery | null): string | null {
  return query === null ? null : JSON.stringify(query);
}

export function NarrativePanel({ client = api, window }: NarrativePanelProps) {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const request = useRef(0);
  const inFlight = useRef(false);
  const key = windowKey(window);

  useEffect(() => {
    request.current += 1;
    inFlight.current = false;
    setState({ status: "idle" });
  }, [key]);

  function write(): void {
    if (window === null || inFlight.current) return;
    inFlight.current = true;
    const id = ++request.current;
    const body = window;
    setState({ status: "pending" });
    void client.narrative(body).then(
      (data) => {
        if (request.current !== id) return;
        inFlight.current = false;
        setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (request.current !== id) return;
        inFlight.current = false;
        setState({ status: "error", message: errorMessage(error) });
      },
    );
  }

  return (
    <section aria-label="Narrative" aria-busy={state.status === "pending"}>
      <h2>Narrative</h2>
      <button
        type="button"
        disabled={window === null || state.status === "pending"}
        onClick={write}
      >
        Write narrative
      </button>
      {window === null ? (
        <p role="status">Sync a repository before asking for a narrative.</p>
      ) : null}
      {state.status === "pending" ? (
        <p role="status" aria-busy="true">
          Writing narrative…
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" data-status="error">
          {state.message}
        </p>
      ) : null}
      {state.status === "ready" ? <NarrativeResult data={state.data} /> : null}
    </section>
  );
}

function NarrativeResult({ data }: { data: NarrativeResponse }) {
  return (
    <>
      <p>
        {data.window.owner}/{data.window.repo} · {data.window.since}–{data.window.until}
      </p>
      <p>{data.narrative}</p>
      <p>
        Hypothesis{" "}
        <span data-hypothesis={data.hypothesis === null ? "none" : "present"}>
          {data.hypothesis ?? "No hypothesis."}
        </span>
      </p>
      <p>
        Confidence <span className="badge">{exact(data.confidence)}</span>
        <meter min={0} max={1} value={data.confidence} aria-label="Confidence" />
      </p>
      {data.evidence.length === 0 ? (
        <p role="status">No evidence cited.</p>
      ) : (
        <ul className="chips" aria-label="Evidence">
          {data.evidence.map((item, index) => (
            <li key={`${item.id}:${index}`}>
              {isTableFactId(item.id) ? (
                <a className="chip" href={`#${item.id}`} onClick={() => highlightFact(item.id)}>
                  {item.id} · {exact(item.value)}
                </a>
              ) : (
                <span className="chip" data-resolved="false">
                  {item.id} · {exact(item.value)} · Not in the tables.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
