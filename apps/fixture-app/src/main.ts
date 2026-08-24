import { buildFixtureApp } from "./server.js";

const port = Number(process.env["FIXTURE_PORT"] ?? "8099");
const fixture = buildFixtureApp({
  widgetScriptUrl: process.env["FIXTURE_WIDGET_URL"] ?? null,
  widgetProductId: process.env["FIXTURE_PRODUCT_ID"] ?? null,
  apiUrl: process.env["FIXTURE_API_URL"] ?? null,
  strictCsp: process.env["FIXTURE_STRICT_CSP"] === "true",
});

await fixture.app.listen({ port, host: "127.0.0.1" });
process.stdout.write(`fixture app listening on http://127.0.0.1:${port}\n`);
