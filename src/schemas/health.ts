import { z } from "zod";

/** Wire shape of the `GET /health` response. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
