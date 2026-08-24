# Integrating SuperGuide with a product

## It is a script tag, not a browser extension

SuperGuide ships as one JavaScript file the customer loads from their own pages. There is no
Chrome extension, and there deliberately never will be: Manifest V3 forbids remote code, which
would mean shipping a new extension build for every behaviour change; enterprise IT blocks
extension installs as a matter of policy; and an extension only works for people who installed
it, which is the wrong population. The people who need help are already on the customer's site.

That constraint shapes the whole browser runtime. The widget mounts in a **closed** shadow root
with a constructed stylesheet, so it cannot restyle the host page and the host page cannot
restyle it. It contains no inline script and no dynamic code construction, so it runs under a
strict Content-Security-Policy without asking the customer to weaken one. It reads, writes, and
removes no CSP header anywhere. If any part of boot fails, it logs once and leaves the page
exactly as it was.

## Seeing it work locally

```
pnpm install
pnpm build
pnpm db:start          # or: docker compose up -d
pnpm demo
```

`pnpm demo` provisions a product, ingests the fixture application's OpenAPI document, starts
both processes, and prints a URL. Open it in any browser.

Without `ANTHROPIC_API_KEY` the planner replays a short recorded transcript so the widget is
still visibly working; the banner says so. Set a real key and the same command plans each turn
with the model.

![The widget on the fixture application](docs/demo.png)

## Onboarding a customer's product

### 1. Create the tenant and the product

One product per site. The `origin_allowlist` is what makes a product id insufficient on its
own: a session can only be opened from an origin on this list, and origin is checked on every
request including the event stream.

```sql
INSERT INTO tenant (name) VALUES ('Northwind Logistics') RETURNING id;

INSERT INTO product (tenant_id, name, origin_allowlist, retention_days)
VALUES ($1, 'Northwind app', '{https://app.northwind.example}', 90)
RETURNING id;
```

Tenant and product creation runs as `sg_migrator`. Everything after this is done through the
console, which connects as `sg_app` and is confined by row-level security to one product.

### 2. Point it at their API

```
POST /internal/onboard?productId=<productId>
Cookie: sg_console=<operator token>

{
  "openApiUrl": "https://app.northwind.example/openapi.json",
  "routeRegistryUrl": "https://app.northwind.example/route-registry.json",
  "apiBaseUrl": "https://api.northwind.example"
}
```

This reads their published OpenAPI document and turns every operation into a callable tool, with
a risk class **derived from the operation, never from the model**:

| Signal | Class |
|---|---|
| `GET`, `HEAD` | read |
| `POST`, `PUT`, `PATCH` | write |
| `DELETE` | destructive |
| path or operation id matching payment, invoice, refund, subscription, charge | financial |
| path or operation id matching email, sms, notify, message, invite | communication |

The strongest match wins, so a `DELETE /payments/{id}` is destructive whatever else it looks
like. **Everything arrives disabled.** A person reviews the derived class and enables each
operation:

```
POST /internal/tools/<toolId>/enable?productId=<productId>
{ "enabled": true }
```

In v1 the policy function blocks `destructive` and `financial` outright, so enabling one of
those makes it callable by the planner but still refused before execution. That is deliberate:
the review and the runtime refusal are separate gates.

Re-running onboarding after their API changes updates each tool and **disables any whose
definition or risk class changed**, so a genuine change goes back through review rather than
being inherited silently.

### 3. Give it credentials for their API

The agent calls the customer's API as a service account they issue. Credentials are sealed with
AES-256-GCM under `SG_SECRET_ENCRYPTION_KEY`, decrypted in exactly one module, and consumed by
the request signer — the plaintext is never returned as a value that could reach a log line or a
trajectory row. Everything written to the trajectory passes through a redactor first.

There is deliberately no support for forwarding an end user's own token into their API. A guard
in the code refuses it while untrusted page or knowledge content is in context, and that guard
is on until the injection posture passes an adversarial evaluation.

### 4. Wire up identity

Asymmetric only. The customer signs with their private key; SuperGuide holds a public key or
fetches their JWKS. The product is structurally incapable of minting a token for one of their
users.

```sql
UPDATE product
   SET jwks_url = 'https://auth.northwind.example/.well-known/jwks.json',
       jwt_issuer = 'https://auth.northwind.example',
       jwt_audience = 'superguide:northwind',
       jwt_algorithms = '{RS256}'
 WHERE id = $1;
```

The permitted algorithms come from this row, **not from the token header**, so a token signed
`HS256` using the public key as the secret is refused before any signature is checked. So are
`alg: none`, an expired token, and one minted for another audience or issuer. Clock skew
tolerance is sixty seconds. Every failure returns the same code, so nothing can be probed.

Three tiers: `anonymous`, `unverified`, `verified`. **Writes require `verified`.** An anonymous
session can read and ask, and nothing else.

### 5. Paste in the script tag

```html
<script src="https://cdn.trysuperguide.com/widget.js"
        id="superguide-widget"
        data-product-id="prod_..."
        data-api-url="https://api.trysuperguide.com"
        async></script>
```

Before it loads, calls queue and are drained in order on boot:

```html
<script>
  window.superguide = window.superguide || function () {
    (window.superguide.q = window.superguide.q || []).push(arguments);
  };

  window.superguide("identify", yourSignedJwt);
</script>
```

Commands: `identify`, `update`, `registerCapabilities`, `setNavigate`, `open`, `close`, `reset`,
and `ask`.

Single-page applications should hand over their router, so navigation does not reload the page:

```js
window.superguide("setNavigate", (path) => router.push(path));
```

The widget announces lifecycle as `sg:` DOM events on `document` — `sg:turn-started`,
`sg:turn-finished`, `sg:message`, `sg:confirm`, `sg:escalation` — since a host page cannot see
inside a closed shadow root.

### 6. Register anything the API cannot reach

A declared capability is the escape hatch, and the only one. Arbitrary JavaScript execution is
never an agent capability.

```js
window.superguide("registerCapabilities", [
  {
    name: "open_seat_dialog",
    description: "Open the seat invitation dialog.",
    risk: "read",
    parameters: { properties: { seatId: { type: "string" } }, required: ["seatId"] },
    parse: (input) => SeatArgs.safeParse(input),
    handler: async ({ seatId }) => {
      await store.dispatch(openSeatDialog(seatId));
      return { status: "ok", data: { opened: seatId } };
    },
  },
]);
```

The **customer's registration** sets the risk class, never the model. Arguments are validated
against the declared schema before the handler is called. A handler that throws is reported with
an honest failure code rather than swallowed. A newly registered capability arrives disabled and
is enabled by a person, exactly like a discovered API operation.

### 7. Author procedures

A procedure is what lets a support lead own the agent's behaviour without an engineer.

```yaml
id: update_billing_address
version: 3
title: Update the customer's billing address
when: user wants to change billing or invoice address
preconditions:
  - user.verified
  - user.role in [owner, billing_admin]
required_scopes: [billing:write]
steps:
  - prefer_api:
      operation: updateBillingAddress
    else_ui:
      goal: Reach billing settings and update the address fields
      route: /settings/billing
      confirm_before: [Save changes]
policy:
  never: [delete account, change plan, issue refund]
  confirm: [any write to payment method]
  escalate_if: [payment declined, tax id mismatch]
success:
  - api:
      operation: getAccount
      json_path: $.billing_address.postal_code
      equals: "{{params.postal_code}}"
```

`POST /internal/procedures?productId=…` validates it and publishes a new version, making it the
active one. An invalid procedure is refused with its issues and **is never partially applied**.
Preconditions are parsed into predicates the system can actually check; prose it cannot evaluate
is rejected at publish time rather than ignored at run time.

The `success` block is the part that matters most. It is re-checked against their API after the
task completes, independently of anything the browser reported. If it does not hold, the person
is told what could not be confirmed and the work is handed to a human — it is never reported as
done.

### 8. Receive escalations

```sql
UPDATE product SET escalation_webhook_url = 'https://northwind.example/hooks/superguide'
 WHERE id = $1;
```

Each delivery carries `x-sg-signature`, an HMAC-SHA256 over `timestamp + "." + body` under
`SG_WEBHOOK_SIGNING_KEY`, and `x-sg-timestamp`. Verify both, and reject a timestamp outside five
minutes:

```js
const expected = crypto.createHmac("sha256", key)
  .update(`${timestamp}.${rawBody}`).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) reject();
if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) reject();
```

The payload carries the transcript, the full trajectory, the failure point, and — separately —
`knownTrue`, which lists only what a check actually confirmed. A `4xx` reply is not retried; a
`5xx` is, with growing delays, and then recorded as a dead letter.

### 9. What the customer's CSP needs

The widget needs no inline script, no `unsafe-eval`, and no relaxed style policy. It does need
to reach the agent endpoint, which is a different origin:

```
script-src 'self' https://cdn.trysuperguide.com;
connect-src 'self' https://api.trysuperguide.com;
```

Nothing else changes, and SuperGuide never touches the header itself.

### 10. Operating the interface, when nothing else can

Grounded actions are off by default and require **both** the global `SG_ENABLE_GROUNDED_ACTIONS`
and the product's own `grounded_actions_enabled`. With either off, no grounded tool is even
compiled, so the planner cannot propose one.

When on, the agent perceives an accessibility digest — roles, accessible names, states — never
raw DOM and never a screenshot. Refs are minted by the observer from a signature that strips
framework-generated identifiers, so they survive a re-render, and they are re-grounded on every
run. No selector chosen by a model is ever stored or replayed. Field values are omitted by
default and appear only when the product's `redaction_allowlist` names the field; a password
field never appears under any configuration.

## Many customers on one deployment

Every tenant-scoped table has row-level security forced on, keyed on `product_id`. The
application connects as `sg_app`, which owns no table and holds no `BYPASSRLS`. Each request
opens a transaction that sets the product scope, and a connection that has not scoped itself
reads zero rows rather than every row.

That means one deployment serves many customers with isolation enforced by the database, not by
application code remembering to add a `WHERE` clause. Per-tenant encryption keys and isolated
vector namespaces are a later phase; today the encryption key is per deployment.

## What is not built

Voice, mobile SDKs, session replay, a Chrome extension, a general-purpose browser agent, helpdesk
integrations beyond one outbound webhook, multi-region, and self-hosting. Each is a deliberate
refusal, not an omission. Session replay in particular is refused on privacy grounds: the
trajectory log answers the same questions and survives a security review.
