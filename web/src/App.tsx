import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client.js";
import { healthQuery } from "./api/queries.js";
import { QueryControls } from "./components/QueryControls.js";

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
      <p>Pick one of your repos, or type any public owner/repo, then sync a UTC date range.</p>
      <p>
        API{" "}
        <span data-status={health.isSuccess ? "ok" : health.isError ? "error" : "pending"}>
          {apiStatus(health)}
        </span>
      </p>
      <QueryControls />
    </main>
  );
}
