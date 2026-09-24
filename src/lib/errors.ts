export type Problem = {
  status: number;
  error: string;
  message: string;
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error",
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
