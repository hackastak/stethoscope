import { ConfigError, loadConfig } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    await startServer(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
