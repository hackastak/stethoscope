import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { openDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";

type App = Awaited<ReturnType<typeof buildApp>>;

export function registerShutdown(app: App): void {
  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

export async function listen(app: App, config: Config): Promise<void> {
  await app.listen({ port: config.port, host: "127.0.0.1" });
}

export async function startServer(config: Config): Promise<App> {
  const client = openDatabase(config.databasePath);
  try {
    migrateDatabase(client.db);
  } catch (error) {
    client.close();
    throw error;
  }

  const app = await buildApp({ config });
  app.addHook("onClose", async () => {
    client.close();
  });
  registerShutdown(app);
  try {
    await listen(app, config);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
