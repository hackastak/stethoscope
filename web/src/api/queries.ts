import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, type SyncRequest, type WindowQuery } from "./client.js";

export function healthQuery(client: ApiClient) {
  return queryOptions({
    queryKey: ["health"] as const,
    queryFn: () => client.health(),
  });
}

export function reposQuery(client: ApiClient, owner?: string) {
  return queryOptions({
    queryKey: ["repos", owner ?? null] as const,
    queryFn: () => client.repos(owner === undefined ? {} : { owner }),
  });
}

export function insightsQuery(client: ApiClient, query: WindowQuery) {
  return queryOptions({
    queryKey: ["insights", query] as const,
    queryFn: () => client.insights(query),
  });
}

export function insightsGraphQuery(client: ApiClient, query: WindowQuery) {
  return queryOptions({
    queryKey: ["insights", "graph", query] as const,
    queryFn: () => client.insightsGraph(query),
  });
}

export function syncMutationOptions(client: ApiClient) {
  return {
    mutationKey: ["sync"] as const,
    mutationFn: (body: SyncRequest) => client.sync(body),
  };
}
