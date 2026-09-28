# Stethoscope

Listen to how a team reviews code. Reciprocity, rubber-stamps, and cycle time from a GitHub repo, plus an LLM narrative that has to cite those numbers.

The Fastify API lives in this directory. The React + Vite UI lives in `web/`. The browser talks only to Vite, which proxies the API, so the GitHub token stays on the server.

## 60-second quickstart

You need Node 20+ (`node -v`, `.nvmrc` is `20`), npm, a read-only GitHub token (below), and an Anthropic API key. Both keys are required to boot. The API listens on `127.0.0.1` only.

```bash
git clone https://github.com/hackastak/stethoscope.git
cd stethoscope
npm install
npm install --prefix web
cp .env.example .env
```

Set `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` in `.env`. Leave the other lines unless you need a different port or model. `.env` is git-ignored. Do not commit it, and do not paste the token into the UI. The UI never asks for one.

```bash
npm run dev
```

The API starts at `http://127.0.0.1:3000`. The first boot creates `./stethoscope.sqlite` (also git-ignored) and runs migrations. If `npm install` fails while building `better-sqlite3`, install a C toolchain (`xcode-select --install` on macOS) and run it again.

In a second terminal, from the same directory

```bash
npm run dev --prefix web
```

Open `http://localhost:5173`.

The repo dropdown lists your repos because `GET /repos` uses the token in your `.env`. It is not a shared catalog. You see repos you own, collaborate on, or can access through an org, including private ones that token can read. You do not see someone else's private repos. A public repo missing from the list can still be typed as `owner/repo`.

If you change `PORT`, set `VITE_API_ORIGIN` in `web/.env` (see `web/.env.example`) so the proxy still finds the API.

## Create a read-only GitHub PAT

Create the token on the GitHub account that should see the dropdown. The app never embeds a token.

### Fine-grained token (use this)

This is the only GitHub token type that can read private repos without also granting write. Fine-grained tokens always include read-only access to public repositories, including ones you do not own. That is why a typed `owner/repo` works for any public repo.

1. Open [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
2. Name it `stethoscope`. Pick a short expiration. Set the resource owner to yourself, or to the org whose private repos should appear.
3. Repository access controls the dropdown, not public read. You can still type any public `owner/repo`.
   - Public only. Choose only select repositories, and select the public repos that should appear.
   - Include private. Choose all repositories, or only the private repos that should appear.
4. Set Pull requests to Read-only. That covers listing pull requests, reviews, review comments, and pull-request commits. Leave Metadata at Read-only so `GET /repos` works. Leave every other repository permission, and every account permission, at No access.
5. Generate the token and put it in `GITHUB_TOKEN`. GitHub shows it once.

A fine-grained token targets one resource owner. An org may have to approve the token before its private repos appear. Public reads still work until then. Another org's private repos need their own token.

### Classic token (public data only)

Open [classic tokens](https://github.com/settings/tokens/new) and leave every scope unchecked. That token can read public repos. It cannot read private repos.

Do not enable `public_repo` or `repo`. `public_repo` can write to public repositories you can push to. `repo` can read private repositories, and it can also write to every repo you can access. For private data, use a fine-grained token.

Get the Anthropic key from the [Anthropic console](https://console.anthropic.com/settings/keys). Only `POST /narrative` uses it.

## Call the API

The API reads `GITHUB_TOKEN` from the environment. It does not take the token on the request. Sync a window, then read it. `GET /insights` and `GET /insights/graph` return 409 until a succeeded sync covers that same `owner`, `repo`, `since`, and `until`. A repo that has never been synced is 404.

Dates are UTC. A date-only value is midnight at the start of that day (`2026-09-01` is `2026-09-01T00:00:00Z`). To include the rest of the last day, pass a datetime with a timezone (`2026-09-28T23:59:59Z`) or unix epoch seconds. Use a short window for the first sync. Sync pages GitHub, then stores the result. Repeating the same window is safe.

Set these once from `owner` and `name` in the `/repos` JSON, or from any public `owner/repo`.

```bash
OWNER=your-github-login
REPO=your-repo
SINCE=2026-09-01
UNTIL=2026-09-28T23:59:59Z
```

Health check. No GitHub call.

```bash
curl -sS http://127.0.0.1:3000/health
```

Repos the token can access. This is the dropdown list. Add `?owner=SOMEONE` to list one user or org's public repos instead.

```bash
curl -sS http://127.0.0.1:3000/repos
curl -sS -G http://127.0.0.1:3000/repos --data-urlencode "owner=$OWNER"
```

Sync pull requests, reviews, and review comments for the window into SQLite.

```bash
curl -sS -X POST http://127.0.0.1:3000/sync \
  -H 'content-type: application/json' \
  -d "{\"owner\":\"$OWNER\",\"repo\":\"$REPO\",\"since\":\"$SINCE\",\"until\":\"$UNTIL\"}"
```

Insights for that window. Facts, leaderboards, cycle time, rubber-stamps, and a reciprocity summary. Same query string as the graph.

```bash
curl -sS -G http://127.0.0.1:3000/insights \
  --data-urlencode "owner=$OWNER" \
  --data-urlencode "repo=$REPO" \
  --data-urlencode "since=$SINCE" \
  --data-urlencode "until=$UNTIL"
```

Reciprocity graph for the same window. `nodes` and `edges`.

```bash
curl -sS -G http://127.0.0.1:3000/insights/graph \
  --data-urlencode "owner=$OWNER" \
  --data-urlencode "repo=$REPO" \
  --data-urlencode "since=$SINCE" \
  --data-urlencode "until=$UNTIL"
```

Narrative for the same window. This calls Anthropic. The local limit is 10 requests per minute per IP (429, `retry-after`). A citation that is not a computed fact id is rejected (502).

```bash
curl -sS -X POST http://127.0.0.1:3000/narrative \
  -H 'content-type: application/json' \
  -d "{\"owner\":\"$OWNER\",\"repo\":\"$REPO\",\"since\":\"$SINCE\",\"until\":\"$UNTIL\"}"
```

Errors are JSON. Validation failures are 400.

```json
{"status":400,"error":"Bad Request","message":"..."}
```

## Frontend

With both processes running, `http://localhost:5173` follows the same path. Pick a repo or type `owner/repo`, choose a UTC range, sync, then read the tables, the graph, and Write narrative. The dropdown only knows the token in `.env`.

## Scripts

Root scripts are `dev`, `build`, `start`, `lint`, `format`, `typecheck`, `test`, `db:generate`, and `eval`.

`npm test` runs the API suite and the `web/` suite. `npm run eval` calls the real model and is not part of the quickstart.

`web/` scripts are `dev`, `build`, `typecheck`, `test`, and `preview`.
