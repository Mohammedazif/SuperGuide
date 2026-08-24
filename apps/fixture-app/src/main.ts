import { loadFixtureEnvironment } from "./env.js";
import { buildFixtureApp } from "./server.js";

const env = loadFixtureEnvironment();
const fixture = buildFixtureApp({
  widgetScriptUrl: env.FIXTURE_WIDGET_URL,
  widgetProductId: env.FIXTURE_PRODUCT_ID,
  apiUrl: env.FIXTURE_API_URL,
  strictCsp: env.FIXTURE_STRICT_CSP,
});

await fixture.app.listen({ port: env.FIXTURE_PORT, host: "127.0.0.1" });
process.stdout.write(`fixture app listening on http://127.0.0.1:${String(env.FIXTURE_PORT)}\n`);
