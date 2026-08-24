import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { billingAddressSchema, seedState, SEED_ACCOUNT_ID, type FixtureState } from "./data.js";
import { FIXTURE_ROUTE_REGISTRY, openApiDocument } from "./openapi.js";
import { renderPage, type PageModel, type Variant } from "./ui.js";
import { z } from "zod";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

// What a customer would actually write: no inline script, no eval, no relaxed style policy,
// and their own agent endpoint allowed under connect-src. The widget needs nothing beyond this.
function strictCsp(apiOrigin: string | null): string {
  const connect = apiOrigin === null ? "'self'" : `'self' ${apiOrigin}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface FixtureOptions {
  widgetBundlePath?: string | null;
  widgetScriptUrl?: string | null;
  widgetProductId?: string | null;
  apiUrl?: string | null;
  strictCsp?: boolean;
  state?: FixtureState;
}

export interface FixtureApp {
  app: FastifyInstance;
  state: FixtureState;
  reset(): void;
}

function queryString(query: unknown, key: string): string | null {
  if (typeof query !== "object" || query === null || !(key in query)) return null;
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Test scaffolding: a real product has the script tag on every page it serves. Remembering the
// pair lets a navigation keep the widget without threading query parameters through every link.
interface WidgetWiring {
  scriptUrl: string | null;
  productId: string | null;
  apiUrl: string | null;
}

function widgetWiring(
  request: { query: unknown; headers: Record<string, string | string[] | undefined> },
  reply: { header: (name: string, value: string) => unknown },
  options: FixtureOptions,
): WidgetWiring {
  const fromQueryProduct = queryString(request.query, "sgProduct");
  const fromQueryApi = queryString(request.query, "sgApi");

  if (fromQueryProduct !== null && fromQueryApi !== null) {
    reply.header(
      "set-cookie",
      `sg_fixture=${encodeURIComponent(`${fromQueryProduct}|${fromQueryApi}`)}; Path=/; SameSite=Lax`,
    );
    return { scriptUrl: "/widget.js", productId: fromQueryProduct, apiUrl: fromQueryApi };
  }

  const remembered = cookieValue(request.headers.cookie, "sg_fixture");
  if (remembered !== null) {
    const [productId, apiUrl] = remembered.split("|");
    if (productId !== undefined && apiUrl !== undefined) {
      return { scriptUrl: "/widget.js", productId, apiUrl };
    }
  }

  return {
    scriptUrl: options.widgetScriptUrl ?? null,
    productId: options.widgetProductId ?? null,
    apiUrl: options.apiUrl ?? null,
  };
}

function variantFrom(query: unknown, headers: Record<string, string | string[] | undefined>): Variant {
  if (typeof query === "object" && query !== null && "variant" in query) {
    const value = (query as { variant?: unknown }).variant;
    if (value === "b") return "b";
  }
  const header = headers["x-fixture-variant"];
  return header === "b" ? "b" : "a";
}

export function buildFixtureApp(options: FixtureOptions = {}): FixtureApp {
  let state = options.state ?? seedState();
  const app = Fastify({ logger: false });

  const asset = (name: string, contentType: string): void => {
    app.get(`/${name}`, (_request, reply) => {
      void reply
        .header("content-type", contentType)
        .header("cache-control", "no-store")
        .send(readFileSync(join(PUBLIC_DIR, name), "utf8"));
    });
  };

  app.addHook("onSend", (request, reply, payload, done) => {
    if (options.strictCsp === true) {
      const wiring = widgetWiring(request, { header: () => undefined }, options);
      const origin = wiring.apiUrl === null ? null : new URL(wiring.apiUrl).origin;
      reply.header("content-security-policy", strictCsp(origin));
    }
    done(null, payload);
  });

  asset("app.css", "text/css; charset=utf-8");
  asset("app.js", "text/javascript; charset=utf-8");

  const bundlePath = options.widgetBundlePath;
  if (bundlePath !== undefined && bundlePath !== null) {
    app.get("/widget.js", (_request, reply) => {
      void reply
        .header("content-type", "text/javascript; charset=utf-8")
        .header("cache-control", "no-store")
        .send(readFileSync(bundlePath, "utf8"));
    });
  }

  app.get("/openapi.json", (request, reply) => {
    const base = `${request.protocol}://${request.headers.host ?? request.hostname}`;
    void reply.send(openApiDocument(base));
  });

  app.get("/route-registry.json", (_request, reply) => {
    void reply.send(FIXTURE_ROUTE_REGISTRY);
  });

  const account = (accountId: string) => state.accounts.get(accountId);

  app.get<{ Params: { accountId: string } }>("/api/v1/accounts/:accountId", (request, reply) => {
    const found = account(request.params.accountId);
    if (found === undefined) return reply.status(404).send({ error: "account_not_found" });
    return reply.send(found);
  });

  app.patch<{ Params: { accountId: string } }>(
    "/api/v1/accounts/:accountId/billing-address",
    (request, reply) => {
      const found = account(request.params.accountId);
      if (found === undefined) return reply.status(404).send({ error: "account_not_found" });

      const parsed = billingAddressSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ error: "invalid_address", issues: parsed.error.issues });
      }
      found.billing_address = parsed.data;
      return reply.send(found);
    },
  );

  app.get<{ Params: { accountId: string } }>(
    "/api/v1/accounts/:accountId/seats",
    (request, reply) => {
      const seats = [...state.seats.values()].filter(
        (seat) => seat.account_id === request.params.accountId && seat.status !== "removed",
      );
      return reply.send({ seats });
    },
  );

  app.post<{ Params: { accountId: string } }>(
    "/api/v1/accounts/:accountId/seats",
    (request, reply) => {
      const found = account(request.params.accountId);
      if (found === undefined) return reply.status(404).send({ error: "account_not_found" });

      const parsed = z
        .object({ email: z.email(), role: z.enum(["billing_admin", "member"]) })
        .safeParse(request.body);
      if (!parsed.success) return reply.status(422).send({ error: "invalid_invite" });

      const id = `seat_${String(state.seats.size + 1).padStart(3, "0")}`;
      const seat = {
        id,
        account_id: found.id,
        email: parsed.data.email,
        role: parsed.data.role,
        status: "invited" as const,
      };
      state.seats.set(id, seat);
      return reply.status(201).send(seat);
    },
  );

  app.delete<{ Params: { accountId: string; seatId: string } }>(
    "/api/v1/accounts/:accountId/seats/:seatId",
    (request, reply) => {
      const seat = state.seats.get(request.params.seatId);
      if (seat === undefined || seat.account_id !== request.params.accountId) {
        return reply.status(404).send({ error: "seat_not_found" });
      }
      seat.status = "removed";
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { accountId: string }; Querystring: { status?: string } }>(
    "/api/v1/accounts/:accountId/invoices",
    (request, reply) => {
      const invoices = [...state.invoices.values()].filter(
        (invoice) =>
          invoice.account_id === request.params.accountId &&
          (request.query.status === undefined || invoice.status === request.query.status),
      );
      return reply.send({ invoices });
    },
  );

  app.post<{ Params: { accountId: string } }>(
    "/api/v1/accounts/:accountId/subscription",
    (request, reply) => {
      const found = account(request.params.accountId);
      if (found === undefined) return reply.status(404).send({ error: "account_not_found" });

      const parsed = z
        .object({ plan: z.enum(["starter", "growth", "scale"]) })
        .safeParse(request.body);
      if (!parsed.success) return reply.status(422).send({ error: "invalid_plan" });

      found.plan = parsed.data.plan;
      return reply.send(found);
    },
  );

  app.get<{ Params: { accountId: string } }>("/api/v1/accounts/:accountId/sso", (request, reply) => {
    const settings = state.sso.get(request.params.accountId);
    if (settings === undefined) return reply.status(404).send({ error: "account_not_found" });
    return reply.send(settings);
  });

  app.put<{ Params: { accountId: string } }>("/api/v1/accounts/:accountId/sso", (request, reply) => {
    const settings = state.sso.get(request.params.accountId);
    if (settings === undefined) return reply.status(404).send({ error: "account_not_found" });

    const parsed = z
      .object({
        enabled: z.boolean(),
        provider: z.enum(["saml", "oidc"]).nullable().optional(),
        metadata_url: z.string().nullable().optional(),
        enforced_domain: z.string().nullable().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(422).send({ error: "invalid_sso_settings" });

    settings.enabled = parsed.data.enabled;
    if (parsed.data.provider !== undefined) settings.provider = parsed.data.provider;
    if (parsed.data.metadata_url !== undefined) settings.metadata_url = parsed.data.metadata_url;
    if (parsed.data.enforced_domain !== undefined) {
      settings.enforced_domain = parsed.data.enforced_domain;
    }
    return reply.send(settings);
  });

  // Deliberately absent from the OpenAPI document: this endpoint exists only behind the form.
  app.post<{ Params: { accountId: string } }>(
    "/internal-ui/accounts/:accountId/registration",
    (request, reply) => {
      const found = account(request.params.accountId);
      if (found === undefined) return reply.status(404).send({ error: "account_not_found" });

      const parsed = z
        .object({ registration_number: z.string().min(1).max(40) })
        .safeParse(request.body);
      if (!parsed.success) return reply.status(422).send({ error: "invalid_registration" });

      found.registration_number = parsed.data.registration_number;
      return reply.send({ registration_number: found.registration_number });
    },
  );

  const page = (path: string, title: string): void => {
    app.get(path, (request, reply) => {
      const seededAccount = state.accounts.get(SEED_ACCOUNT_ID);
      const sso = state.sso.get(SEED_ACCOUNT_ID);
      if (seededAccount === undefined || sso === undefined) {
        return reply.status(500).send("fixture state is missing its seed account");
      }

      const model: PageModel = {
        variant: variantFrom(request.query, request.headers),
        title,
        path,
        account: seededAccount,
        seats: [...state.seats.values()],
        invoices: [...state.invoices.values()],
        sso,
        ...(() => {
          const wiring = widgetWiring(request, reply, options);
          return {
            widgetScriptUrl: wiring.scriptUrl,
            widgetProductId: wiring.productId,
            apiUrl: wiring.apiUrl,
          };
        })(),
      };
      return reply.header("content-type", "text/html; charset=utf-8").send(renderPage(model));
    });
  };

  page("/account", "Account");
  page("/settings/billing", "Billing settings");
  page("/settings/seats", "Seats");
  page("/settings/sso", "Single sign-on");
  page("/invoices", "Invoices");

  app.get<{ Params: { invoiceId: string } }>("/invoices/:invoiceId", (request, reply) => {
    const seededAccount = state.accounts.get(SEED_ACCOUNT_ID);
    const sso = state.sso.get(SEED_ACCOUNT_ID);
    const invoice = state.invoices.get(request.params.invoiceId);
    if (seededAccount === undefined || sso === undefined) {
      return reply.status(500).send("fixture state is missing its seed account");
    }

    const model: PageModel = {
      variant: variantFrom(request.query, request.headers),
      title: invoice === undefined ? "Invoice not found" : `Invoice ${invoice.number}`,
      path: "/invoices/:invoiceId",
      account: seededAccount,
      seats: [...state.seats.values()],
      invoices: [...state.invoices.values()],
      sso,
      ...(() => {
        const wiring = widgetWiring(request, reply, options);
        return {
          widgetScriptUrl: wiring.scriptUrl,
          widgetProductId: wiring.productId,
          apiUrl: wiring.apiUrl,
        };
      })(),
    };
    return reply
      .status(invoice === undefined ? 404 : 200)
      .header("content-type", "text/html; charset=utf-8")
      .send(renderPage(model, invoice));
  });

  app.get("/", (_request, reply) => reply.redirect("/account"));

  return {
    app,
    get state() {
      return state;
    },
    reset() {
      state = seedState();
    },
  };
}
