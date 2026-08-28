# Local Testing Guide

One SuperGuide control plane. Two frontends.

| Piece | Repo | What you run |
|---|---|---|
| Backend | SuperGuide | Fastify on `http://127.0.0.1:8080` |
| Widget | SuperGuide | Script tag on the fixture app (`:8099`) |
| Extension | SuperGuide-Anywhere | Unpacked Chrome extension |

The widget calls `/v1`. The extension calls `/v1/anywhere`. Do not put `/v1/anywhere` in the extension’s `apiBase`.

---

## 1. Start the backend (once)

```bash
cd /home/spidewol/Documents/Support-agent/superguide
pnpm install
pnpm env:init
```

If `env:init` says `.env already exists`, leave it. Do not pass `--force` unless you want new signing keys.

`pnpm env:init` writes `.env` and fills the signing keys. Then edit `.env`:

1. Set the model key for the provider you use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`) and `SG_MODEL_PROVIDER` to match.
2. Leave `SG_ALLOWED_EXTENSION_IDS` as the placeholder for now. You will replace it with your real Chrome extension ID in step 3.

```bash
pnpm db:start          # or: docker compose up -d
pnpm db:migrate
pnpm --filter @superguide/control-plane run dev
```

The server is up when it logs that it is listening on port `8080`.

Leave this terminal running.

---

## 2. Widget — see it on a page

In a **second** terminal:

```bash
cd /home/spidewol/Documents/Support-agent/superguide
pnpm build
pnpm demo
```

That prints a URL (fixture app on `:8099` with the widget injected). Open it in any browser.

Without a real model key, `pnpm demo` still works: it replays a short recorded transcript. With a key set, it plans each turn live.

`Try: What plan are we on?`

To run fixture + control plane yourself instead of `pnpm demo`:

```bash
pnpm --filter @superguide/widget run build
pnpm --filter @superguide/fixture-app run dev
# control plane already running from step 1
```

---

## 3. Extension — load it in Chrome

The extension is a separate checkout next to SuperGuide.

### 3a. Build it

```bash
cd /home/spidewol/Documents/Support-agent/superguide-anywhere
pnpm install
pnpm run build
```

### 3b. Load unpacked

1. Open Chrome at `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** →  
   `/home/spidewol/Documents/Support-agent/superguide-anywhere/apps/extension/dist`
4. Copy the **extension ID** (long string on the card, like `ghdcebndlanhmdeajdbbemcaihpenhoj`).

### 3c. Allow that extension on the backend

In SuperGuide `.env`:

```env
SG_ALLOWED_EXTENSION_IDS=chrome-extension://PASTE_THE_ID_HERE
```

Restart the control plane (Ctrl+C in the step 1 terminal, then `pnpm --filter @superguide/control-plane run dev` again). Without this, every extension call is `403 origin_rejected`.

### 3d. Point the extension at local SuperGuide

Default `sga.apiBase` is already `http://127.0.0.1:8080`. If you need to set it:

1. On `chrome://extensions/`, click **service worker** on the SuperGuide Anywhere card.
2. In that console:

```javascript
chrome.storage.local.set({ 'sga.apiBase': 'http://127.0.0.1:8080' })
```

3. Reload the extension (refresh icon on the card).

Do **not** set `apiBase` to `http://127.0.0.1:8080/v1/anywhere`. The client adds `/v1/anywhere` itself.

### 3e. Use it

Open any site (the SuperGuide fixture at `http://127.0.0.1:8099` is a good one). Click the extension icon, activate the origin (`observe` or `control`), and type a task.

---

## Ports

| Port | Process |
|---|---|
| `55432` | PostgreSQL (SuperGuide) |
| `8080` | Control plane |
| `8099` | Fixture app (widget demo) |

---

## If something fails

| Symptom | Check |
|---|---|
| Control plane exits at start | `.env` keys: `pnpm env:init` (skip if the file already exists), then the model API key |
| `SG_*` all `undefined` | Stop the watcher (Ctrl+C) and start `dev` again after this repo loads `.env` from the SuperGuide root |
| Widget not on the fixture page | `pnpm build` so `apps/widget/dist` exists, then `pnpm demo` |
| Extension `403 origin_rejected` | `SG_ALLOWED_EXTENSION_IDS=chrome-extension://<id>` and restart the server |
| Extension `401` / cannot register | `sga.apiBase` is `http://127.0.0.1:8080` with no path suffix |
| Extension does nothing | Control plane is running; `SG_ANYWHERE_AGENT=on` |
| Postgres connection refused | `pnpm db:start` or `docker compose up -d`, then `pnpm db:migrate` |

---

## Hosted (before first deploy)

The API image bootstraps `sg_app` / `sg_migrator` and runs migrations on start. You still need a
Postgres with `vector`, a **direct** (not pooled) connection, and a Render **Starter** (or larger)
web service from `render.yaml`. Do not use Render's free instance: it sleeps and drops in-flight
turns.

```bash
pnpm env:init                 # once; then fill the model key
# Set SG_DATABASE_URL to postgres://sg_app:...@db.<ref>.supabase.co:5432/postgres?sslmode=require
# Set SG_MIGRATION_DATABASE_URL to postgres://postgres:...@db.<ref>.supabase.co:5432/postgres?sslmode=require
# On Render, SG_PUBLIC_ORIGIN can stay unset (RENDER_EXTERNAL_URL is used). Set it for a custom domain.
pnpm db:bootstrap             # optional from a laptop; the container also does this
pnpm db:migrate               # optional from a laptop; the container also does this
```

`SG_ALLOWED_EXTENSION_IDS` is already the stable Chrome ID from the extension manifest key
(`chrome-extension://ghdcebndlanhmdeajdbbemcaihpenhoj`). Rebuild the extension with
`SGA_API_BASE=https://<service>.onrender.com pnpm run build` in SuperGuide Anywhere.

Keep `numInstances: 1`. Do not proxy the API hostname through Cloudflare (grey-cloud / DNS only);
SSE needs an unbuffered connection.

## Tests

From SuperGuide:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:security
pnpm test:e2e                  # widget in a browser
pnpm test:e2e:extension        # needs the Anywhere extension dist built
```

`test:e2e:extension` loads `../superguide-anywhere/apps/extension/dist` (or `SUPERGUIDE_ANYWHERE_ROOT`).
