# Notes

Submission notes for Stethoscope. `README.md` is the quickstart, including the token steps and a curl for every endpoint. This file is the tour.

## How to run

Node 20 or newer. The API and the page are separate packages, so both installs are required. Both keys are required to boot. Neither is committed.

```bash
npm install
npm install --prefix web
cp .env.example .env
```

Set `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` in `.env`. Then:

```bash
npm run dev
npm run dev --prefix web
```

The API listens on `http://127.0.0.1:3000`. The page is `http://localhost:5173` and proxies the API, so the browser never sees the token. The first boot creates `./stethoscope.sqlite` and runs migrations.

Create a fine-grained GitHub token with Pull requests set to Read-only. Classic tokens with no scopes can read public repos only. Do not enable `public_repo` or `repo`. Those are write. The README has the click path and the curls.

Sync a window before you read it. `POST /sync` requires `since` and `until`. A repo that has never been synced is 404 on `GET /insights`. A window no succeeded sync covers is 409. `POST /narrative` calls Anthropic and is limited to 10 requests per minute per IP.

## Architecture

The service is a Fastify API. The page is React on Vite. GitHub is contacted only by `POST /sync`. That route pages pull requests, reviews, and review comments through Octokit, then upserts them into SQLite (`better-sqlite3`, Drizzle). A repeat of the same window updates entity rows in place and appends one `sync_runs` row. `GET /insights`, `GET /insights/graph`, and `POST /narrative` read that store. They do not call GitHub. A read with no dates uses the last 30 days. Sync does not. That split is deliberate: a write has to say what to fetch, a read can default.

The contract the model sees is a fact list, not prose and not the raw GitHub payload. Each headline has a stable id, such as `fact:rubberstamp:grace`, `fact:reciprocity:grace->ada`, and `fact:cycletime:first_review_p50`. `POST /narrative` sends only those facts to Anthropic, behind an `LLMProvider` so the model is a config value. The model must return a narrative, a hypothesis, a confidence in `[0, 1]`, and evidence ids. The service checks every id against the facts it sent, retries once if an id is unknown, and returns 502 rather than a citation it cannot resolve. The response puts the resolved number next to each id. An identical fact list, prompt version, and model is served from a process-local cache. The page's evidence chips link to the table cells that carry those ids.

Main decisions:

- The database is the source of truth for queries. GitHub is a sync input, not a read dependency.
- Grounding is enforced. A made-up fact id is an error, not a sentence the client can display.
- SQLite, so a local run has no second service. Metric functions take loaded rows. They do not embed SQL.
- One token in the environment, never in the browser and never in the repo. See Access.
- Sync is on demand. There is no worker. The upsert is the seam a schedule would call.
- Bots are stored and excluded from the metrics. A pull, review, or comment with no author is stored as GitHub's ghost user and the sync continues. Distinct deleted accounts collapse to that one login.
- Thresholds come from the environment (`FAST_APPROVAL_SECONDS=300`, `MIN_PR_SIZE=100`, `MIN_RECIPROCITY_INTERACTIONS=3`). They are not per-request overrides.

## Metrics

The interesting question is review culture, not volume. Leaderboards are in the response so the counts are visible. They are not the headline.

### Reciprocity

An edge `A → B` is the number of B's pull requests that A reviewed in the window. A second review of the same pull request does not add weight. Self-reviews are dropped.

The pair ratio is `weight / reverseWeight`. It is null when the reverse edge is absent, not infinity. A person's score is `1 - |given - received| / (given + received)`. 1 is balanced. 0 is entirely one-way. An edge is flagged when it is one-way and its weight is at least `MIN_RECIPROCITY_INTERACTIONS` (default 3). One below that is noise, not a flag.

Why: raw review counts hide the shape. A person who always reviews someone and is never reviewed back is a seniority gradient, a silo, or a single-reviewer dependency. The flag is a hypothesis for the narrative, not a verdict.

Blind spots: a small team is asymmetric by nature. A specialist who alone owns an area should show up as one-way, and that can be healthy. The threshold filters one-off reviews. It does not know why the remaining edge exists. Offline review is invisible, so a pair that talks in person and clicks Approve on GitHub looks one-way.

### Rubber-stamp

An approval is low-scrutiny only when all three are true:

- Time to approval is strictly under `FAST_APPROVAL_SECONDS` (default 300). The clock starts at the last commit at or before the review, then `ready_at`, then `created_at`. Equal to 300 is not fast.
- That reviewer left 0 review comments on the pull request. Another person's comments do not count. A body on the review is not a review comment.
- Pull request size (`additions + deletions`) is strictly over `MIN_PR_SIZE` (default 100). Equal to 100 is not large. Changed-file count is not size.

The rate is flagged approvals over eligible approvals. Eligible means `APPROVED` with a non-negative time to approval. An approval submitted before every baseline is excluded, not scored as clean. No eligible approvals is a null rate, not 0. The same denominator is split per reviewer and per reviewer→author pair, including a self-approval.

Why: coverage can be high while scrutiny is not. A fast, silent approval on a large change is the cheap proxy the API can see.

Blind spots: a fast silent approval of a typo is correct, which is why the size floor exists. Review that happened in person, or in a comment outside the review-comment API, looks silent and will false-positive. The clock is a lower bound on attention, not a measure of it. `ready_at` is read from the issue timeline's ready-for-review event, so a draft's time before it was marked ready is excluded from the wait. It is null only for pull requests that were never drafts, which were ready at creation and fall back to `created_at`.

### Also computed

Cycle time splits a merged pull request into ready→first review, first review→first approval, and first approval→merge. Each stage is a median and a p75 (type-7). A missing stage is left out of that sample. It is not stored as 0. Load balance is a Gini over review counts and a bus factor at half of review or authorship volume. Empty input is a null Gini, not 0.

## Access

Whoever runs the app supplies their own GitHub token in `.env`. Nothing in the repo is a credential, and the server does not accept a token on the request. `GET /repos` lists the repos that token can access: owned, collaborator, and org-member, public and private. The dropdown is that list. A public repo that is not in the list can still be typed as `owner/repo`. A runner does not see anyone else's private repos. That is the point. A reviewer uses their token and sees their repos. We do not ask for credentials to a private org.

Login with GitHub is the hosted version, and it is not built. It would be a GitHub OAuth App, an authorize redirect, a callback that exchanges the code, a session cookie, and a per-user token stored on the server (encrypted, not logged). Each request would build its GitHub client from that token instead of from `GITHUB_TOKEN`. `GET /repos` would then list that person's repos. The cost is a callback, session storage, and token lifecycle, which fights a 60-second local run. PAT-per-user is the local path. OAuth is the path if this is ever hosted for more than one person.

## What I'd do next

- Add a scheduled sync that calls the same upsert. The store already separates fetch from query.
- For a hosted deploy, swap the database driver and the table definitions from `better-sqlite3` / `sqliteTable` to Drizzle's Postgres driver. The metric functions do not change. Docker shows up at that point: a Postgres service plus the API. It is absent now because SQLite needs no extra process. This is not a one-line swap. The schema imports `drizzle-orm/sqlite-core`, including integer booleans and SQL checks.
- Plot the same facts across successive windows. Add a second forge behind the fetch interface. Keep the deterministic eval, and add a graded rubric only as a second pass. `npm run eval` stays manual. It can spend a real model call, so CI does not run it.

## What AI was used for

AI coding agents implemented this repository from a written task plan: the API, the metrics, the tests, the page, the README, and this file. The tools were Claude Code and pi. The plan named the metrics, the grounding rule, and the acceptance checks before the code for those tasks was written. Where a task had more than one defensible answer, the choice was written down instead of left in a commit message.

The narrative eval does not use a model as a judge. It checks shape, confidence range, and citation ids. The only model call in the running product is `POST /narrative`, which uses the Anthropic key and `LLM_MODEL` from the environment.
