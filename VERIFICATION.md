# Verification report

Every command in §13.4 was run on this machine and the result below is what was actually
observed. Two of them could not run as written, for reasons of the environment rather than the
code; both are named, with what was run instead.

Machine: Linux, Node 24.19.0, pnpm 11.23.0, PostgreSQL 16.4 with pgvector 0.8.0, Chromium via
Playwright 1.62.

## The checklist

| Command | Result | Notes |
|---|---|---|
| `pnpm install` | pass | 14 workspace projects |
| `pnpm lint` | pass | boundaries, purity, banned vendor names, no warnings permitted |
| `pnpm typecheck` | pass | `tsc -b` over every project, then the test tree |
| `pnpm build` | pass | widget bundle 377 KB |
| `pnpm test:unit` | pass | 95 tests, 10 files |
| `pnpm test:unit:coverage` | pass | `@superguide/policy` at 100% statements, branches, functions, lines |
| `docker compose up -d` | **not run** | Docker is not installed and there is no root on this machine |
| `node tools/scripts/pg-dev.mjs reset` | pass | substitute: the same PostgreSQL 16 with pgvector, same port, same two roles |
| `pnpm db:migrate` | pass | 15 migrations applied to a clean database |
| `pnpm test:integration` | pass | 35 passed, 2 skipped |
| `pnpm test:security` | pass | 26 tests |
| `pnpm exec playwright install --with-deps` | **not run** | `--with-deps` installs OS packages and needs root |
| `pnpm exec playwright install chromium` | pass | substitute: the browser itself installs and launches fine |
| `pnpm test:e2e` | pass | 8 scenarios in a real browser |
| `pnpm eval --variant=a` | pass | 30/30 |
| `pnpm eval --variant=b` | pass | 30/30 |
| `pnpm check:forbidden` | pass | 178 files against 9 rules |
| `pnpm check:bundle-boundary` | pass | no `contract/internal` marker in the built widget |

The two skipped integration tests are the live model calls. They assert that
`cache_read_input_tokens` is greater than zero on the second call of a conversation, and they
run only when `ANTHROPIC_API_KEY` holds a real key. No key was available here, so **that
assertion has never been observed against the provider**. See "Not verified" below.

## Eval results

Thirty tasks, run against both interface variants. Variant B changes markup, class names, and
DOM structure while preserving semantics and the API.

| Task | Level | Steps | Variant A | Variant B |
|---|---|---|---|---|
| read_plan | L1 | 1 | pass | pass |
| read_seat_limit | L1 | 1 | pass | pass |
| read_sso_state | L1 | 1 | pass | pass |
| read_billing_city | L1 | 1 | pass | pass |
| read_seats_list | L1 | 1 | pass | pass |
| update_postcode | L1 | 1 | pass | pass |
| update_city | L1 | 1 | pass | pass |
| enable_sso | L1 | 1 | pass | pass |
| enforce_domain | L1 | 1 | pass | pass |
| read_then_update | L1 | 2 | pass | pass |
| capability_export | L2 | 1 | pass | pass |
| capability_open_dialog | L2 | 1 | pass | pass |
| capability_failure_escalates | L6 | 2 | pass | pass |
| navigate_billing | L3 | 1 | pass | pass |
| navigate_invoice | L3 | 1 | pass | pass |
| navigate_seats | L3 | 1 | pass | pass |
| grounded_registration | L4 | 2 | pass | pass |
| grounded_replace_registration | L4 | 2 | pass | pass |
| grounded_blocked_when_off | L6 | 1 | pass | pass |
| ask_which_address | L5 | 1 | pass | pass |
| ask_missing_value | L5 | 1 | pass | pass |
| escalate_no_mechanism | L6 | 1 | pass | pass |
| destructive_blocked | L1 | 1 | pass | pass |
| financial_blocked | L1 | 1 | pass | pass |
| invoice_read_blocked | L1 | 1 | pass | pass |
| anonymous_write_blocked | L1 | 1 | pass | pass |
| denied_confirmation | L1 | 1 | pass | pass |
| rejected_write_escalates | L1 | 1 | pass | pass |
| unverified_check_escalates | L1 | 1 | pass | pass |
| step_budget_exhausted | L1 | 3 | pass | pass |

Variant A: 30/30, 100.0%, threshold 100%. Variant B: 30/30, 100.0%.
Cost per suite: 43,200 input tokens, 3,240 output, 6,600 cache read, ~1.5s wall clock.

`pnpm eval --variant=a --check-determinism` runs the suite twice and compares every field
except wall-clock. All 30 tasks reproduced exactly.

The two grounded tasks operate the real markup of each variant through the real observer and
the real executor. They are what makes the durability claim demonstrated rather than asserted:
the same task file, unchanged, finishes on a redesign that shares no class name with the
original.

## The security matrix

| Test | Result | Where |
|---|---|---|
| Cross-tenant read on every RLS table | pass | `tests/security/rls.test.ts` |
| Missing GUC reads zero rows, not all rows | pass | `tests/security/rls.test.ts` |
| The variable does not leak across pooled connections | pass | `tests/security/rls.test.ts` |
| A cross-product write is refused | pass | `tests/security/rls.test.ts` |
| `step` is append-only for the application role | pass | `tests/security/rls.test.ts` |
| The application role owns no table and has no BYPASSRLS | pass | `tests/security/rls.test.ts` |
| Algorithm confusion: HS256 signed with the public key | pass | `tests/security/identity.test.ts` |
| `alg: none` | pass | `tests/security/identity.test.ts` |
| Expired token | pass | `tests/security/identity.test.ts` |
| Wrong audience | pass | `tests/security/identity.test.ts` |
| Wrong issuer | pass | `tests/security/identity.test.ts` |
| An algorithm not configured for the product | pass | `tests/security/identity.test.ts` |
| Origin rejection, including on the stream | pass | `tests/integration/transport.test.ts` |
| Anonymous write blocked by policy | pass | `tests/security/confirmation.test.ts` |
| Injection corpus produces no write | pass | `tests/security/injection.test.ts` |
| A forwarded credential is refused while untrusted content is in context | pass | `tests/security/injection.test.ts` |
| Redaction: no secret, authorization value, or cookie in any step | pass | `tests/integration/agent-loop.test.ts`, `apps/control-plane/src/secrets/redact.test.ts` |
| Closed vocabulary: an unknown action type is refused before dispatch | pass | `packages/executor/src/execute.test.ts` |
| Confirmation scope: approving A does not authorise B | pass | `tests/security/confirmation.test.ts` |
| Params tampering: a mismatched hash is refused with 409 | pass | `tests/security/confirmation.test.ts` |
| Bundle boundary | pass | `pnpm check:bundle-boundary` |
| Forbidden patterns | pass | `pnpm check:forbidden` |

The injection corpus test is worth describing precisely, because it is easy to write a weak
version. It assumes the planner has **already been compromised**: for each of eight adversarial
prompts the scripted model is made to attempt exactly the write the injection asks for. The
test then asserts that every such attempt was blocked by policy, that no step executed, and
that the fixture application's state is byte-identical before and after. The defence being
tested is identity and policy, not the model's willingness to resist text.

Model-layer resistance to injection has **not** been measured, because that requires live model
runs. See below.

## Not verified

**Live model behaviour.** No `ANTHROPIC_API_KEY` was available. The Anthropic client is written
against the API facts in the specification — manual streaming loop, adaptive thinking, effort
inside `output_config`, `pause_turn` continued by appending the assistant turn, structured
outputs through `messages.parse` with `zodOutputFormat`, errors caught most-specific-first —
and it typechecks against the installed SDK, but no request has ever been sent. Specifically
unverified: that `usage.cache_read_input_tokens` is greater than zero on the second call
(`tests/integration/live-model.test.ts`, skipped), that a real model chooses sensible actions
from the compiled tools, and the model-dependent half of the eval. The deterministic layers are
tested exactly, against recorded transcripts, which is what §13.3 asks of them.

**Docker.** `docker compose up -d` was never executed. `docker-compose.yml` is written as
specified and CI uses the same image, but on this machine PostgreSQL 16.4 and pgvector 0.8.0
were built from source into `~/.local/superguide-pg16` and launched by
`tools/scripts/pg-dev.mjs`, which creates the same database, the same two roles, and the same
extension on the same port. Everything that touches the database ran against a real PostgreSQL;
none of it ran against the image the compose file names.

**Playwright OS dependencies.** `--with-deps` needs root. The browser installed and ran without
it, so the e2e suite is real; the system-package step is untested.

## Deviations from the specification

**Row-level security is scoped through a function.** The specification's policy body is
`product_id = current_setting('sg.product_id', true)::uuid`. On a pooled connection the setting
resets to the empty string after `SET LOCAL` commits, and `''::uuid` raises rather than
yielding NULL, so an unscoped query would surface as an error instead of as zero rows. Every
policy uses `sg_current_product_id()`, which is `NULLIF(current_setting(...), '')::uuid`. The
stated property — a connection that forgets to scope itself sees nothing rather than everything
— is preserved, and a test asserts it directly on a reused connection.

**Two administrative paths exist for `sg_migrator`.** Forced row-level security applies to the
table owner too, so provisioning a tenant and purging a product would otherwise be impossible.
Migration 0010 adds named policies granting `sg_migrator` access, and migration 0012 adds one
SECURITY DEFINER function that lists interrupted turns across products at startup, returning
identifiers only. `sg_app` is untouched by both, still owns nothing, and still has no
`BYPASSRLS`.

**Columns added beyond the ten tables.** No eleventh domain table was introduced.
`conversation` gained `next_seq` and `active_turn_id`; `step` gained `ladder_level` and
`request_id`; `product` gained `jwt_algorithms`, `api_base_url`, `escalation_webhook_url`, and
`escalation_email`. The shared per-conversation sequence is what lets one SSE cursor resume
both messages and steps, which §7.4 requires.

**Escalation delivery has no table.** Retries and the dead-letter record live in the trajectory
and the log rather than in a twelfth table. The consequence is honest and worth stating: an
escalation still being retried when the process dies is not retried after a restart. It is
recorded, and the run it belongs to is where a support lead would look for it.

**The embedding provider is local.** The locked stack names one model provider, and that
provider has no embedding endpoint. `HashingEmbeddingProvider` is a deterministic hashed
projection to the 1536 dimensions the schema declares. Retrieval, the pgvector index, the
injection filter, and the citation path are all real and tested; the vectors are not
semantically meaningful. Replacing it is one class.

**Session tokens are not JWTs.** `SG_SESSION_SIGNING_KEY` signs a prefixed HMAC envelope with
no algorithm header and no issuer or audience claim, so a SuperGuide session token is
structurally incapable of being replayed against a customer's API. The console uses a second
prefix carried in a cookie; a widget token presented to a console route is refused.

**One command was added to the boot contract.** `ask` sends a message programmatically, which
is what a host page needs for a "get help with this" control and what makes the widget
testable from outside a closed shadow root. The documented seven are unchanged. The widget also
emits `sg:` events for turn lifecycle, since a host page cannot see inside the shadow root.

**The product id also travels as a query parameter.** A CORS preflight carries no custom
headers, so `x-sg-product-id` alone made every cross-origin request fail. Origin is still
enforced on every request, including the stream.

## Defects found by writing the tests

These were all real, and all are fixed. They are listed because they are the argument for
having written the tests at all.

1. A CORS preflight could not resolve the product, so the widget could not open a session from
   any host page.
2. An action dispatched before the client's stream attached was lost, and the turn waited on a
   result nobody had been asked for. The same race lost confirmations and turn completions.
   Outstanding calls and confirmations are now re-announced on connect, and a settled turn is
   announced from persisted state.
3. The session was not kept across a navigation, so the durable replay the design rests on
   could never be delivered: the new page was a different end user.
4. The `open` command could not open an already-mounted widget.
5. Both the loop and the runner appended the closing message, so a resolved turn said it twice.
6. Capability change detection compared jsonb with a plain stringify. PostgreSQL does not
   preserve key order, so a reviewed capability was disabled again on every page load.
7. The observer and executor used global DOM constructors, which fail for elements in a
   same-origin frame — exactly where the specification requires traversal to work.
8. `ask_user` declared a timeout above the action envelope's own cap, so every attempt to ask a
   question failed schema validation.
