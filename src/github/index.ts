export {
  createGitHubClient,
  type GitHubClient,
  type GitHubClientOptions,
  type GitHubLog,
} from "./client.js";
export { fetchPullRequests } from "./pulls.js";
export type {
  FetchPullRequestsOptions,
  FetchPullRequestsQuery,
  GitHubActor,
  PullRequestDto,
} from "./types.js";
