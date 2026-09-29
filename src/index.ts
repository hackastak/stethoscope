import { loadConfig } from "./config.js";
import { formatStartupError } from "./lib/errors.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
}

void main().catch((error: unknown) => {
  console.error(formatStartupError(error));
  process.exit(1);
});
