# Stethoscope

> Listen to how your team really reviews code — reciprocity, rubber-stamps, and
> cycle time from any GitHub repo, with an LLM narrative grounded in the numbers.

A small, production-grade TypeScript service that integrates with the GitHub API
and surfaces collaboration-quality insights about how a team reviews code.

**Status:** scaffolding (Phase 0). No features implemented yet — see the phased
task breakdown in the project notes.

## Stack

- **Runtime:** Node 20+, TypeScript (ESM)
- **HTTP:** Fastify
- **Storage:** SQLite (better-sqlite3 + Drizzle) — added in Phase 1
- **GitHub:** Octokit — added in Phase 2
- **LLM:** Anthropic SDK behind a swappable provider — added in Phase 5
- **Validation:** zod
- **Tests:** Vitest

## Layout

```
src/        API service (routes, db, github, metrics, facts, llm, schemas)
test/       Vitest suites (metric math + API integration)
eval/       Deterministic LLM-narrative eval harness
web/        React + Vite frontend (Phase 7)
```

## Getting started

```bash
npm install
cp .env.example .env   # fill in your own GitHub PAT + Anthropic key
npm run dev            # boots the process
```

Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`.
