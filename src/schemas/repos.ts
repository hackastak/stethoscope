import { z } from "zod";
import { GITHUB_SLUG } from "./sync.js";

const slug = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(GITHUB_SLUG, "must match ^[A-Za-z0-9_.-]+$");

export const reposQuerySchema = z
  .object({
    owner: slug.optional(),
  })
  .strict();

export type ReposQuery = z.infer<typeof reposQuerySchema>;

/** Wire shape of one repo in the `GET /repos` response. */
export const repoSummarySchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  visibility: z.enum(["public", "private", "internal"]),
  defaultBranch: z.string(),
  /** Unix epoch seconds. Null when GitHub has no push timestamp. */
  pushedAt: z.number().nullable(),
});

export const reposResponseSchema = z.array(repoSummarySchema);

export type RepoVisibility = z.infer<typeof repoSummarySchema>["visibility"];
export type RepoSummary = z.infer<typeof repoSummarySchema>;

export function formatReposIssues(error: z.ZodError): string {
  if (error.issues.length === 0) return "Invalid query";
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const label = issue.keys.length === 1 ? "key" : "keys";
        return `query: unrecognized ${label} ${issue.keys.join(", ")}`;
      }
      const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "query";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}
