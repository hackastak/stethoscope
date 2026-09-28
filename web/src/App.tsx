import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client.js";
import { healthQuery } from "./api/queries.js";

function apiStatus(state: { isPending: boolean; isError: boolean; error: Error | null }): string {
  if (state.isPending) return "checking…";
  if (state.isError) return state.error?.message ?? "unreachable";
  return "ok";
}

export function App() {
  const health = useQuery(healthQuery(api));

  return (
    <main>
      <h1>Stethoscope</h1>
      <p>Pick a repo and a date range in the next step. This page only checks the API.</p>
      <p>
        API{" "}
        <span data-status={health.isSuccess ? "ok" : health.isError ? "error" : "pending"}>
          {apiStatus(health)}
        </span>
      </p>
    </main>
  );
}
