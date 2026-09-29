/**
 * The HTTP wire contract shared by the API and the web client.
 *
 * Everything re-exported here is derived from zod request/response schemas or
 * plain types whose home modules have NO server-only dependencies (no Octokit,
 * Fastify, or db). That is what lets the SPA import these types across the
 * package boundary without dragging the server graph into its typecheck or its
 * bundle. Keep this file, and the modules it points at, free of server-only
 * imports — if a wire type needs one, mint a dep-clean schema for it instead.
 *
 * The web imports these type-only (`import type`), so the re-exported zod
 * schemas below are erased from the browser build.
 */
export type { Problem } from "./lib/errors.js";
export { healthResponseSchema, type HealthResponse } from "./schemas/health.js";
export {
  repoSummarySchema,
  reposResponseSchema,
  type RepoSummary,
  type RepoVisibility,
} from "./schemas/repos.js";
export {
  syncBodySchema,
  syncResponseSchema,
  type SyncBody,
  type SyncRequest,
  type SyncResponse,
} from "./schemas/sync.js";
export type { InsightsGraphResponse, InsightsResponse } from "./schemas/insights.js";
export type { NarrativeResponse } from "./schemas/narrative.js";
