import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().min(1).default("./stethoscope.sqlite"),
  FAST_APPROVAL_SECONDS: z.coerce.number().int().positive().default(300),
  MIN_PR_SIZE: z.coerce.number().int().nonnegative().default(100),
  MIN_RECIPROCITY_INTERACTIONS: z.coerce.number().int().positive().default(3),
});

export type Config = Readonly<{
  githubToken: string;
  anthropicApiKey: string;
  llmModel: string;
  port: number;
  databasePath: string;
  fastApprovalSeconds: number;
  minPrSize: number;
  minReciprocityInteractions: number;
}>;

function isMissing(issue: z.ZodIssue): boolean {
  return issue.code === "invalid_type" && "received" in issue && issue.received === "undefined";
}

function formatIssues(error: z.ZodError): string {
  const missing = [
    ...new Set(error.issues.filter(isMissing).map((issue) => String(issue.path[0] ?? "unknown"))),
  ];
  const invalid = [
    ...new Set(error.issues.filter((issue) => !isMissing(issue)).map((issue) => String(issue.path[0] ?? "unknown"))),
  ];

  const parts: string[] = [];
  if (missing.length > 0) {
    const label = missing.length === 1 ? "variable" : "variables";
    parts.push(`Missing required environment ${label}: ${missing.join(", ")}`);
  }
  if (invalid.length > 0) {
    const label = invalid.length === 1 ? "variable" : "variables";
    parts.push(`Invalid environment ${label}: ${invalid.join(", ")}`);
  }
  return parts.join(". ") || "Invalid environment configuration";
}

function normalizeEnv(env: NodeJS.Dict<string>): NodeJS.Dict<string> {
  const normalized: NodeJS.Dict<string> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key] = value === "" ? undefined : value;
  }
  return normalized;
}

export function loadConfig(env: NodeJS.Dict<string> = process.env): Config {
  if (env === process.env) {
    loadDotenv({ quiet: true });
  }
  const result = envSchema.safeParse(normalizeEnv(env));
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }

  return Object.freeze({
    githubToken: result.data.GITHUB_TOKEN,
    anthropicApiKey: result.data.ANTHROPIC_API_KEY,
    llmModel: result.data.LLM_MODEL,
    port: result.data.PORT,
    databasePath: result.data.DATABASE_PATH,
    fastApprovalSeconds: result.data.FAST_APPROVAL_SECONDS,
    minPrSize: result.data.MIN_PR_SIZE,
    minReciprocityInteractions: result.data.MIN_RECIPROCITY_INTERACTIONS,
  });
}
