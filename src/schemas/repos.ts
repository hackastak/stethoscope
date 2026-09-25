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
