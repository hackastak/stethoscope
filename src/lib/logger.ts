import pino, { type DestinationStream, type Logger } from "pino";
import type { Config } from "../config.js";
import { redactSecrets } from "./errors.js";

export function createLogger(config: Config, stream?: DestinationStream): Logger {
  const secrets = [config.githubToken, config.anthropicApiKey];

  return pino(
    {
      level: "info",
      redact: {
        paths: [
          "githubToken",
          "anthropicApiKey",
          "*.githubToken",
          "*.anthropicApiKey",
          "req.headers.authorization",
        ],
        censor: "[REDACTED]",
      },
      hooks: {
        streamWrite(s) {
          return redactSecrets(s, secrets);
        },
      },
    },
    stream,
  );
}
