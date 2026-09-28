# Web frontend

React + Vite + TanStack Query SPA. The typed client lives in `src/api/client.ts`.

```bash
npm install
npm run dev
```

`npm run dev` serves the app and proxies `/health`, `/repos`, `/sync`, `/insights`, and `/narrative` to the API. The default target is `http://127.0.0.1:3000` (`PORT`'s default). Override it with `VITE_API_ORIGIN` — see `.env.example`. The client calls those paths on the same origin, so the browser does not talk to the API port directly.

Start the API from the repo root (`npm run dev`) before expecting the health line to say ok.

The page lists the token owner's repos from `GET /repos`, accepts any public `owner/repo`, and defaults the date range to the last 30 UTC days. Sync sends that inclusive range to `POST /sync`, then loads `GET /insights` for the same window. If repo discovery fails, type the slug anyway.
