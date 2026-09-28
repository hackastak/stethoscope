import { z } from "zod";

/**
 * Model completion for `/narrative`, before evidence ids are checked or resolved.
 * `hypothesis` is null when the facts do not support a cause — Decisions Q24.
 * Confidence bounds are enforced here. The API JSON Schema drops min/max — Q21, Q26.
 * Whether an evidence id was actually provided is `synthesize` (T22), not this schema.
 */
export const narrativeOutputSchema = z
  .object({
    narrative: z.string().min(1),
    hypothesis: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1)),
  })
  .strict();

export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;
