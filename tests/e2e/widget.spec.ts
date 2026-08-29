import { expect, test, type Page } from "@playwright/test";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { pageUrl, startStack, type E2EStack } from "./harness.js";

interface RecordedEvent {
  name: string;
  detail: Record<string, unknown>;
}

declare global {
  interface Window {
    __sgEvents?: RecordedEvent[];
    __sgHighlighted?: string[];
    superguide?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  }
}

// Closed shadow root is opaque to the automation API; assert only host-visible surfaces.
async function recordEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__sgEvents = [];
    for (const name of [
      "turn-started",
      "turn-finished",
      "turn-failed",
      "message",
      "confirm",
      "escalation",
    ]) {
      document.addEventListener(`sg:${name}`, (event) => {
        window.__sgEvents?.push({
          name,
          detail: (event as CustomEvent<Record<string, unknown>>).detail,
        });
      });
    }
  });
}

async function waitForWidget(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.superguide === "function", null, {
    timeout: 20_000,
  });
}

async function identify(page: Page, stack: E2EStack): Promise<void> {
  const token = await stack.mintIdentityToken("dana@northwind.example", ["billing:write"]);
  await page.evaluate((value) => {
    window.superguide?.("identify", value);
  }, token);
  await page.waitForTimeout(300);
}

async function ask(page: Page, text: string): Promise<void> {
  await page.evaluate((message) => {
    window.superguide?.("ask", message);
  }, text);
}

async function events(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(() => window.__sgEvents ?? []);
}

// Confirmation is in a closed shadow root; keyboard (autofocused approve) is the only driver.
async function waitForConfirmation(page: Page): Promise<RecordedEvent> {
  await page.waitForFunction(
    () => (window.__sgEvents ?? []).some((entry) => entry.name === "confirm"),
    null,
    { timeout: 25_000 },
  );
  const recorded = await events(page);
  const confirmation = recorded.find((entry) => entry.name === "confirm");
  if (confirmation === undefined) throw new Error("no confirm event was recorded");
  return confirmation;
}

async function approve(page: Page): Promise<RecordedEvent> {
  const confirmation = await waitForConfirmation(page);
  await page.keyboard.press("Enter");
  return confirmation;
}

async function refuse(page: Page): Promise<RecordedEvent> {
  const confirmation = await waitForConfirmation(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  return confirmation;
}

async function waitForTurn(page: Page): Promise<RecordedEvent> {
  await page.waitForFunction(
    () => (window.__sgEvents ?? []).some((entry) => entry.name === "turn-finished"),
    null,
    { timeout: 30_000 },
  );
  const recorded = await events(page);
  const finished = recorded.find((entry) => entry.name === "turn-finished");
  if (finished === undefined) throw new Error("no turn-finished event was recorded");
  return finished;
}

test.describe("the widget in a real browser", () => {
  let stack: E2EStack;

  test.beforeAll(async () => {
    stack = await startStack({ groundedActions: true });
  });

  test.afterAll(async () => {
    await stack.close();
  });

  test.beforeEach(async ({ page }) => {
    stack.resetFixture();
    await recordEvents(page);
  });

  test("mounts in a closed shadow root and leaves the host page alone", async ({ page }) => {
    await page.goto(pageUrl(stack, "/account"));
    await waitForWidget(page);

    const inspected = await page.evaluate(() => {
      const host = document.getElementById("superguide-root");
      return {
        exists: host !== null,
        shadowReachable: host?.shadowRoot !== null && host?.shadowRoot !== undefined,
        hostChildren: host?.childElementCount ?? -1,
      };
    });

    expect(inspected.exists).toBe(true);
    expect(inspected.shadowReachable).toBe(false);
    expect(inspected.hostChildren).toBe(0);

    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByLabel("Company registration number")).toBeVisible();
  });

  test("level one: resolves from the customer's API", async ({ page }) => {
    stack.setScript([
      {
        toolName: "api_getAccount",
        toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
      },
      {
        toolName: "finish",
        toolInput: {
          intent: "Report the plan.",
          summary: "You are on the growth plan with 25 seats.",
          resolutionState: "resolved",
        },
      },
    ]);

    await page.goto(pageUrl(stack, "/account"));
    await waitForWidget(page);
    await ask(page, "What plan are we on?");

    const finished = await waitForTurn(page);
    expect(finished.detail["resolutionState"]).toBe("resolved");
    expect(String(finished.detail["summary"])).toContain("growth plan");

    // turn-started is best-effort to live connections; durable message + settled state asserted.
    const recorded = await events(page);
    expect(
      recorded.some(
        (entry) => entry.name === "message" && String(entry.detail["text"]).includes("growth plan"),
      ),
    ).toBe(true);
    expect(
      recorded.some((entry) => entry.name === "message" && entry.detail["role"] === "user"),
    ).toBe(true);
  });

  test("level two: invokes a capability the page registered", async ({ page }) => {
    stack.setScript([
      {
        toolName: "capability_highlight_invoice",
        toolInput: { intent: "Highlight the open invoice.", invoiceId: "inv_2026_06" },
      },
      {
        toolName: "finish",
        toolInput: {
          intent: "Report.",
          summary: "I have highlighted the open invoice.",
          resolutionState: "resolved",
        },
      },
    ]);

    await page.addInitScript(() => {
      window.__sgHighlighted = [];
      const queue: unknown[][] = [];
      const shim = (...args: unknown[]): void => {
        queue.push(args);
      };
      shim.q = queue;
      window.superguide = shim;
      window.superguide("registerCapabilities", [
        {
          name: "highlight_invoice",
          description: "Highlight one invoice row.",
          risk: "read",
          parameters: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
          handler: (argument: { invoiceId: string }) => {
            window.__sgHighlighted?.push(argument.invoiceId);
            const row = document.querySelector(`a[href$="${argument.invoiceId}"]`);
            row?.setAttribute("data-highlighted", "true");
            return { status: "ok", data: { highlighted: argument.invoiceId } };
          },
        },
      ]);
    });

    await page.goto(pageUrl(stack, "/invoices"));
    await page.waitForFunction(() => document.getElementById("superguide-root") !== null, null, {
      timeout: 20_000,
    });
    await ask(page, "Show me the invoice we still owe.");

    const finished = await waitForTurn(page);
    expect(finished.detail["resolutionState"]).toBe("resolved");

    const highlighted = await page.evaluate(() => window.__sgHighlighted ?? []);
    expect(highlighted).toEqual(["inv_2026_06"]);
    await expect(page.locator('a[data-highlighted="true"]')).toHaveCount(1);
  });

  test("level three: navigates the product without stranding the turn", async ({ page }) => {
    stack.setScript([
      { toolName: "navigate_billing_settings", toolInput: { intent: "Take you to billing." } },
      {
        toolName: "finish",
        toolInput: {
          intent: "Report.",
          summary: "You are on the billing settings page.",
          resolutionState: "resolved",
        },
      },
    ]);

    await page.goto(pageUrl(stack, "/account"));
    await waitForWidget(page);
    await ask(page, "Where do I change our billing details?");

    await page.waitForURL(/\/settings\/billing/, { timeout: 25_000 });
    await expect(page.getByRole("heading", { name: "Billing address" })).toBeVisible();

    // Dispatcher page is gone; nothing may remain owing a result.
    await waitForWidget(page);
    await page.waitForFunction(
      () => Object.keys(localStorage).filter((key) => key.startsWith("sg.pending.")).length === 0,
      null,
      { timeout: 20_000 },
    );

    const delivered = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("sg.delivered.")),
    );
    expect(delivered.length).toBeGreaterThan(0);
  });

  test("level four: finishes a task the API and routes cannot reach", async ({ page }) => {
    stack.setScript([
      {
        toolName: "ui_set_value",
        toolInput: {
          intent: "Type the registration number.",
          ref: "{{ref:Company registration number}}",
          value: "SC441122",
        },
      },
      {
        toolName: "ui_click",
        toolInput: { intent: "Save it.", ref: "{{ref:Save registration}}" },
      },
      {
        toolName: "finish",
        toolInput: {
          intent: "Report.",
          summary: "Your registration number is saved.",
          resolutionState: "resolved",
        },
      },
    ]);

    await page.goto(pageUrl(stack, "/account"));
    await waitForWidget(page);
    await identify(page, stack);
    await ask(page, "Set our company registration number to SC441122.");

    await approve(page);

    const finished = await waitForTurn(page);
    expect(finished.detail["resolutionState"]).toBe("resolved");

    await expect(page.getByLabel("Company registration number")).toHaveValue("SC441122");
    await expect(page.locator("#registration-status")).toHaveText("Saved");

    const state = await page.evaluate(async () => {
      const response = await fetch(`/api/v1/accounts/acct_01HQ8G7Z2K`);
      return (await response.json()) as { registration_number: string | null };
    });
    expect(state.registration_number).toBe("SC441122");
  });

  test("level four works identically on the redesigned interface", async ({ page }) => {
    stack.setScript([
      {
        toolName: "ui_set_value",
        toolInput: {
          intent: "Type the registration number.",
          ref: "{{ref:Company registration number}}",
          value: "NI778899",
        },
      },
      { toolName: "ui_click", toolInput: { intent: "Save it.", ref: "{{ref:Save registration}}" } },
      {
        toolName: "finish",
        toolInput: { intent: "Report.", summary: "Saved.", resolutionState: "resolved" },
      },
    ]);

    await page.goto(pageUrl(stack, "/account", "b"));
    await expect(page.locator(".c-panel")).toHaveCount(1);
    await waitForWidget(page);
    await identify(page, stack);
    await ask(page, "Set our company registration number to NI778899.");

    await approve(page);

    const finished = await waitForTurn(page);
    expect(finished.detail["resolutionState"]).toBe("resolved");
    await expect(page.getByLabel("Company registration number")).toHaveValue("NI778899");
  });

  test("a write asks before it acts, and a refusal changes nothing", async ({ page }) => {
    stack.setScript([
      {
        toolName: "api_updateBillingAddress",
        toolInput: {
          intent: "Change the postcode.",
          accountId: SEED_ACCOUNT_ID,
          line1: "18 Harbour Road",
          city: "Bristol",
          postal_code: "EH3 9DR",
          country: "GB",
        },
      },
    ]);

    await page.goto(pageUrl(stack, "/settings/billing"));
    await waitForWidget(page);
    await identify(page, stack);
    await ask(page, "Change our billing postcode to EH3 9DR.");

    const confirmation = await refuse(page);
    expect(String(confirmation.detail["preview"])).toContain("EH3 9DR");

    const finished = await waitForTurn(page);
    expect(finished.detail["resolutionState"]).toBe("escalated");

    const account = await page.evaluate(async () => {
      const response = await fetch(`/api/v1/accounts/acct_01HQ8G7Z2K`);
      return (await response.json()) as { billing_address: { postal_code: string } };
    });
    expect(account.billing_address.postal_code).toBe("BS1 4TT");
  });

  test("works on a page served with a strict content security policy", async ({ browser }) => {
    const strict = await startStack({ strictCsp: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await recordEvents(page);

      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
          violations.push(message.text());
        }
      });

      strict.setScript([
        {
          toolName: "api_getAccount",
          toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "You are on the growth plan.",
            resolutionState: "resolved",
          },
        },
      ]);

      const response = await page.goto(pageUrl(strict, "/account"));
      expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

      await waitForWidget(page);
      await ask(page, "What plan are we on?");

      const finished = await waitForTurn(page);
      expect(String(finished.detail["summary"])).toContain("growth plan");
      expect(violations).toEqual([]);

      await context.close();
    } finally {
      await strict.close();
    }
  });
});
