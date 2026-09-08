# SuperGuide

In-app resolution agent for B2B SaaS. A customer loads one script on their product. When someone is stuck, SuperGuide finishes the task: it calls the product API, runs registered capabilities, navigates routes, and says so when it cannot.

This repo is the **backend** and the **in-app widget**. The Chrome extension lives in [SuperGuide Anywhere](https://github.com/Mohammedazif/SuperGuide-Anywhere). One control plane serves both: the widget on `/v1`, the extension on `/v1/anywhere`.

## Stack

- **Backend:** Node 22, TypeScript, Fastify, PostgreSQL 16 + pgvector, Drizzle
- **Widget / console:** Preact, bundled with tsup
- **Models:** Anthropic (default), OpenAI, or Gemini

## Quickstart

Needs Node 22+, pnpm 11, and PostgreSQL 16 with pgvector (or Docker).

```bash
pnpm install
pnpm env:init
```

`pnpm env:init` writes `.env` and fills the signing keys. Set the model key for the provider you use, then:

```bash
pnpm db:start          # or: docker compose up -d
pnpm db:migrate
pnpm build
pnpm demo
```

That prints a URL. Open it and the widget is on the fixture app.

To run the processes yourself instead of `pnpm demo`:

```bash
pnpm --filter @superguide/fixture-app run dev
pnpm --filter @superguide/control-plane run dev
```

| Port | Process |
|---|---|
| `55432` | PostgreSQL |
| `8080` | Control plane |
| `8099` | Fixture app |

![The widget on the fixture application](docs/demo.png)

## Model providers

Set `SG_MODEL_PROVIDER` and the matching key. Only the selected provider's key is required.

| Provider | Key | Planner | Classifier |
|---|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-opus-5` | `claude-haiku-4-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-5.5` | `gpt-5.4-mini` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-pro` | `gemini-2.5-flash` |

Without a key, `pnpm demo` still loads the widget and replays a short recorded transcript.

## How a task runs

Deterministic steps first; the page digest is the fallback, not the default.

| Level | Mechanism |
|---|---|
| L1 | API call compiled from the tenant's OpenAPI document |
| L2 | Typed client capability the customer registered |
| L3 | Route navigation from the product's route registry |
| L4 | Grounded UI action over the accessibility digest (off unless `SG_ENABLE_GROUNDED_ACTIONS` and the product both allow it) |
| L5 | Ask the person one precise question |
| L6 | Escalate to a person with the full trajectory |

Nothing is reported done until a predicate has been checked against real state.

## Layout

```
apps/control-plane   Fastify server, agent runtime, migrations, console
apps/widget          IIFE bundle loaded on the customer's page
apps/console         support-lead surface
apps/fixture-app     demo SaaS with an API and OpenAPI document
packages/contract    Zod schemas for wire and storage
packages/policy      allow / deny verdicts
packages/adapters    site adapters used by the extension
packages/procedures  procedure schema, loader, matcher
packages/observer    DOM → accessibility digest (read only)
packages/executor    closed action vocabulary
packages/client-core transport, SSE, dispatch
packages/widget-ui   chat UI in a closed shadow root
```

## SuperGuide Anywhere

Build and load the extension from the SuperGuide Anywhere repo. Allow it on this backend:

```env
SG_ALLOWED_EXTENSION_IDS=chrome-extension://<id from chrome://extensions>
```

Restart the control plane after changing that value. The extension's `apiBase` is the origin only (`http://127.0.0.1:8080`); it appends `/v1/anywhere` itself.

Hosted deploys use `render.yaml`. Set `SG_PUBLIC_ORIGIN` (or leave it unset on Render so `RENDER_EXTERNAL_URL` is used) and point the extension at that origin.
