const address = {
  type: "object",
  required: ["line1", "city", "postal_code", "country"],
  properties: {
    line1: { type: "string" },
    line2: { type: "string", nullable: true },
    city: { type: "string" },
    postal_code: { type: "string" },
    country: { type: "string", minLength: 2, maxLength: 2 },
  },
} as const;

export function openApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Northwind Logistics API", version: "1.4.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/v1/accounts/{accountId}": {
        get: {
          operationId: "getAccount",
          summary: "Read an account including its billing address and plan",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "The account" } },
        },
      },
      "/api/v1/accounts/{accountId}/billing-address": {
        patch: {
          operationId: "updateBillingAddress",
          summary: "Replace the billing address on an account",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: address } },
          },
          responses: { "200": { description: "The updated account" } },
        },
      },
      "/api/v1/accounts/{accountId}/seats": {
        get: {
          operationId: "listSeats",
          summary: "List the seats on an account",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Seats" } },
        },
        post: {
          operationId: "inviteSeat",
          summary: "Invite a person to a seat by email",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "role"],
                  properties: {
                    email: { type: "string" },
                    role: { type: "string", enum: ["billing_admin", "member"] },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "The invited seat" } },
        },
      },
      "/api/v1/accounts/{accountId}/seats/{seatId}": {
        delete: {
          operationId: "removeSeat",
          summary: "Remove a seat from an account",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
            { name: "seatId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "204": { description: "Removed" } },
        },
      },
      "/api/v1/accounts/{accountId}/invoices": {
        get: {
          operationId: "listInvoices",
          summary: "List invoices for an account",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Invoices" } },
        },
      },
      "/api/v1/accounts/{accountId}/subscription": {
        post: {
          operationId: "changeSubscription",
          summary: "Change the subscription plan on an account",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["plan"],
                  properties: { plan: { type: "string", enum: ["starter", "growth", "scale"] } },
                },
              },
            },
          },
          responses: { "200": { description: "The updated account" } },
        },
      },
      "/api/v1/accounts/{accountId}/sso": {
        get: {
          operationId: "getSsoSettings",
          summary: "Read single sign-on settings",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Settings" } },
        },
        put: {
          operationId: "updateSsoSettings",
          summary: "Replace single sign-on settings",
          parameters: [
            { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["enabled"],
                  properties: {
                    enabled: { type: "boolean" },
                    provider: { type: "string", enum: ["saml", "oidc"], nullable: true },
                    metadata_url: { type: "string", nullable: true },
                    enforced_domain: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Settings" } },
        },
      },
    },
  };
}

export const FIXTURE_ROUTE_REGISTRY = {
  routes: [
    { id: "account_overview", title: "Account overview", template: "/account", params: [], requiresScopes: [] },
    { id: "billing_settings", title: "Billing settings", template: "/settings/billing", params: [], requiresScopes: [] },
    { id: "seat_settings", title: "Seats", template: "/settings/seats", params: [], requiresScopes: [] },
    { id: "sso_settings", title: "Single sign-on", template: "/settings/sso", params: [], requiresScopes: [] },
    { id: "invoice_list", title: "Invoices", template: "/invoices", params: [], requiresScopes: [] },
    { id: "invoice_detail", title: "One invoice", template: "/invoices/{invoiceId}", params: ["invoiceId"], requiresScopes: [] },
  ],
};
