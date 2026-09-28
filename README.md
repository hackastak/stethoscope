# Stethoscope

> Listen to how your team really reviews code — reciprocity, rubber-stamps, and
> cycle time from any GitHub repo, with an LLM narrative grounded in the numbers.

A small, production-grade TypeScript service that integrates with the GitHub API
and surfaces collaboration-quality insights about how a team reviews code.

**Status:** active development. The core pipeline is in place — GitHub sync,
SQLite storage, the review metrics (reciprocity, rubber-stamps, cycle time, load
balance, bus factor), citeable facts, the `/insights` and `/insights/graph`
endpoints, the grounded LLM narrative, and the React + Vite web frontend. See the
phased task breakdown in the project notes for what remains.

## Stack

- **Runtime:** Node 20+, TypeScript (ESM)
- **HTTP:** Fastify
- **Storage:** SQLite (better-sqlite3 + Drizzle)
- **GitHub:** Octokit
- **LLM:** Anthropic SDK behind a swappable provider
- **Validation:** zod
- **Tests:** Vitest

## Layout

```
src/        API service (routes, db, github, metrics, facts, llm, schemas)
test/       Vitest suites (metric math + API integration)
eval/       Deterministic LLM-narrative eval harness
web/        React + Vite frontend
```

## Getting started

Stethoscope runs as **two processes**: the Fastify API (repo root) and the
React + Vite frontend (`web/`). The frontend proxies API calls to the backend,
so for local development you run both side by side.

### Prerequisites

- **Node 20+** (see `.nvmrc` — `nvm use` if you use nvm)
- A GitHub read-only Personal Access Token (for `/sync`)
- An Anthropic API key (for `/narrative`)

### 1. Install dependencies

Dependencies live in two `package.json` files — install both:

```bash
npm install            # repo root (API)
npm install --prefix web   # frontend
```

### 2. Configure environment

```bash
cp .env.example .env   # fill in your own GitHub PAT + Anthropic key
```

Key settings in `.env`:

- `GITHUB_TOKEN` — required for the `/sync` (GitHub data) endpoint
- `ANTHROPIC_API_KEY` / `LLM_MODEL` — required for the `/narrative` endpoint
- `PORT` — API port (default `3000`)
- `DATABASE_PATH` — SQLite file (default `./stethoscope.sqlite`)

The app boots without valid keys, but the `/sync` and `/narrative` endpoints
will fail until they are set.

### 3. Run both processes

Open two terminals. **Start the backend first** — the frontend's health check
stays not-ok until the API is up.

**Terminal 1 — backend (API):**

```bash
npm run dev            # Fastify on http://127.0.0.1:3000
```

**Terminal 2 — frontend (web UI):**

```bash
npm run dev --prefix web   # Vite on http://localhost:5173
```

Then open **http://localhost:5173** in your browser.

### How they connect

The browser only ever talks to the Vite origin. `web/vite.config.ts` proxies
`/health`, `/repos`, `/sync`, `/insights`, and `/narrative` to the API, so there
are no CORS issues and the browser never calls the API port directly.

If you change the API `PORT`, set `VITE_API_ORIGIN` in `web/.env` to match
(e.g. `http://127.0.0.1:4000`) — see `web/.env.example`.

## Scripts

**Root (API):** `dev`, `build`, `start`, `lint`, `format`, `typecheck`, `test`,
`db:generate`.

**`web/`:** `dev`, `build`, `typecheck`, `preview`.
