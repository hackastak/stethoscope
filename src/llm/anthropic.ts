import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import { redactSecrets } from "../lib/errors.js";
import { LlmOutputError, LlmRequestError, type LLMProvider } from "./provider.js";

/** Narrative JSON is short. Not an env knob — see Decisions Q23. */
export const MAX_OUTPUT_TOKENS = 2048;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AnthropicProviderOptions = {
  fetch?: FetchLike;
  maxTokens?: number;
};

type JsonSchema = Record<string, unknown>;

export function createAnthropicProvider(
  config: Config,
  options: AnthropicProviderOptions = {},
): LLMProvider {
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    fetch: options.fetch,
    logLevel: "off",
    maxRetries: 0,
  });
  const maxTokens = options.maxTokens ?? MAX_OUTPUT_TOKENS;

  return {
    async complete(prompt, schema) {
      const jsonSchema = toJsonSchema(schema);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: config.llmModel,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          output_config: {
            format: { type: "json_schema", schema: jsonSchema },
          },
        });
      } catch (error) {
        throw requestError(error, config.anthropicApiKey);
      }
      return parseOutput(message, schema, config.anthropicApiKey);
    },
  };
}

function requestError(error: unknown, secret: string): LlmRequestError {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  const raw =
    error instanceof Error && error.message.length > 0 ? error.message : "LLM request failed";
  const detail = redactSecrets(raw, [secret]);
  const prefix = status === undefined ? "LLM request failed" : `LLM request failed (${status})`;
  return new LlmRequestError(`${prefix}: ${detail}`);
}

function parseOutput<T>(message: Anthropic.Message, schema: z.ZodType<T>, secret: string): T {
  if (message.stop_reason !== "end_turn") {
    throw new LlmOutputError(stopMessage(message.stop_reason));
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text.length === 0) {
    throw new LlmOutputError("LLM returned no text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmOutputError("LLM output was not valid JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new LlmOutputError(
      redactSecrets(`LLM output did not match the schema: ${issues}`, [secret]),
    );
  }
  return result.data;
}

function stopMessage(stopReason: Anthropic.Message["stop_reason"]): string {
  if (stopReason === "refusal") return "LLM refused the request";
  if (stopReason === "max_tokens") return "LLM output was truncated";
  return "LLM stopped before a complete answer";
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("LLM output schema must be a zod object");
  }
  return objectSchema(schema);
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = fieldSchema(value);
    if (isRequired(value)) required.push(key);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function isRequired(schema: z.ZodType): boolean {
  return !(schema instanceof z.ZodOptional || schema instanceof z.ZodDefault);
}

function fieldSchema(schema: z.ZodType): JsonSchema {
  let current = schema;
  let nullable = false;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    if (current instanceof z.ZodNullable) nullable = true;
    current = current instanceof z.ZodDefault ? current.removeDefault() : current.unwrap();
  }

  const base = coreSchema(current);
  if (!nullable) return base;
  if (typeof base.type === "string") return { ...base, type: [base.type, "null"] };
  return { anyOf: [base, { type: "null" }] };
}

function coreSchema(schema: z.ZodType): JsonSchema {
  if (schema instanceof z.ZodObject) return objectSchema(schema);
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) {
    return {
      type: schema._def.checks.some((check) => check.kind === "int") ? "integer" : "number",
    };
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array", items: fieldSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: [...schema.options] };
  if (schema instanceof z.ZodLiteral) return literalSchema(schema.value);
  throw new Error(`Unsupported LLM output schema: ${schema.constructor.name}`);
}

function literalSchema(value: unknown): JsonSchema {
  if (typeof value === "string") return { type: "string", enum: [value] };
  if (typeof value === "number") return { type: "number", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  if (value === null) return { type: "null" };
  throw new Error("Unsupported LLM output schema: literal");
}
