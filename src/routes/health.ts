import type { FastifyPluginAsync } from "fastify";
import type { HealthResponse } from "../schemas/health.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));
};
