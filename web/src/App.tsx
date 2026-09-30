import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type WindowQuery } from "./api/client.js";
import { healthQuery } from "./api/queries.js";
import { InsightTables } from "./components/InsightTables.js";
import { NarrativePanel } from "./components/NarrativePanel.js";
import { QueryControls } from "./components/QueryControls.js";
import { ReciprocityGraph } from "./components/ReciprocityGraph.js";

function apiStatus(state: { isPending: boolean; isError: boolean; error: Error | null }): string {
  if (state.isPending) return "checking…";
  if (state.isError) return state.error?.message ?? "unreachable";
  return "ok";
}

export function App() {
  const health = useQuery(healthQuery(api));
  const [window, setWindow] = useState<WindowQuery | null>(null);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⌇
          </span>
          <div>
            <h1>Stethoscope</h1>
            <p className="tagline">
              Pick one of your repos, or type any public owner/repo, then sync a UTC date range.
            </p>
          </div>
        </div>
        <span
          className="api-pill"
          role="status"
          data-status={health.isSuccess ? "ok" : health.isError ? "error" : "pending"}
        >
          API <strong>{apiStatus(health)}</strong>
        </span>
      </header>
      <main className="page">
        <div className="card">
          <QueryControls onWindowChange={setWindow} />
        </div>
        <div className="grid">
          <div className="card span-2">
            <InsightTables window={window} />
          </div>
          <div className="card">
            <ReciprocityGraph window={window} />
          </div>
          <div className="card">
            <NarrativePanel window={window} />
          </div>
        </div>
      </main>
    </>
  );
}
