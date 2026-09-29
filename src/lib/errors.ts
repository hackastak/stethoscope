export type Problem = {
  status: number;
  error: string;
  message: string;
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

export function problem(status: number, message: string): Problem {
  return {
    status,
    error: STATUS_TEXT[status] ?? "Error",
    message,
  };
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (out, secret) => (secret.length > 0 ? out.split(secret).join("[REDACTED]") : out),
    value,
  );
}

/** Startup failures go to stderr, not the pino logger. Scrub env secrets before that write. */
export function formatStartupError(error: unknown, env: NodeJS.Dict<string> = process.env): string {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const secrets = [env.GITHUB_TOKEN, env.ANTHROPIC_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return redactSecrets(message, secrets);
}

export function errorToProblem(
  error: unknown,
  { secrets }: { production: boolean; secrets: string[] },
): Problem {
  const status =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 500;

  const rawMessage =
    error instanceof Error && error.message.length > 0 ? error.message : "Internal Server Error";
  const message = redactSecrets(rawMessage, secrets);

  return problem(status >= 400 && status < 600 ? status : 500, message);
}
