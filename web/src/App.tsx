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
    <main>
      <h1>Stethoscope</h1>
      <p>Pick one of your repos, or type any public owner/repo, then sync a UTC date range.</p>
      <p>
        API{" "}
        <span data-status={health.isSuccess ? "ok" : health.isError ? "error" : "pending"}>
          {apiStatus(health)}
        </span>
      </p>
      <QueryControls onWindowChange={setWindow} />
      <InsightTables window={window} />
      <ReciprocityGraph window={window} />
      <NarrativePanel window={window} />
    </main>
  );
}
