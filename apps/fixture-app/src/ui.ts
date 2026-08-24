import type { Account, Invoice, Seat, SsoSettings } from "./data.js";

export type Variant = "a" | "b";

export interface PageModel {
  variant: Variant;
  title: string;
  path: string;
  account: Account;
  seats: Seat[];
  invoices: Invoice[];
  sso: SsoSettings;
  widgetScriptUrl: string | null;
  widgetProductId: string | null;
  apiUrl: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

function field(
  variant: Variant,
  id: string,
  label: string,
  value: string,
  type = "text",
): string {
  const safeValue = escapeHtml(value);
  if (variant === "a") {
    return `<p class="field"><label for="${id}">${label}</label>
      <input id="${id}" name="${id}" type="${type}" class="input" value="${safeValue}"></p>`;
  }
  return `<div class="c-form__row" data-field="${id}">
    <label class="c-form__label" for="${id}">${label}</label>
    <span class="c-form__control"><input class="c-form__input" id="${id}" name="${id}" type="${type}" value="${safeValue}"></span>
  </div>`;
}

function billingSection(model: PageModel): string {
  const address = model.account.billing_address;
  const fields = [
    field(model.variant, "line1", "Address line 1", address.line1),
    field(model.variant, "line2", "Address line 2", address.line2 ?? ""),
    field(model.variant, "city", "City", address.city),
    field(model.variant, "postal_code", "Postal code", address.postal_code),
    field(model.variant, "country", "Country", address.country),
  ].join("\n");

  if (model.variant === "a") {
    return `<section aria-labelledby="billing-heading">
      <h2 id="billing-heading">Billing address</h2>
      <form id="billing-form" data-account="${model.account.id}">
        ${fields}
        <button type="submit" class="primary">Save changes</button>
        <output id="billing-status" role="status"></output>
      </form>
    </section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="billing-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="billing-heading">Billing address</h2></div>
    <form class="c-form" id="billing-form" data-account="${model.account.id}">
      <div class="c-form__grid">${fields}</div>
      <div class="c-form__actions">
        <button class="c-btn c-btn--primary" type="submit">Save changes</button>
        <output class="c-form__status" id="billing-status" role="status"></output>
      </div>
    </form>
  </div>`;
}

function seatsSection(model: PageModel): string {
  const rows = model.seats
    .filter((seat) => seat.status !== "removed")
    .map((seat) =>
      model.variant === "a"
        ? `<tr><td>${escapeHtml(seat.email)}</td><td>${seat.role}</td><td>${seat.status}</td></tr>`
        : `<div class="c-list__row" role="row"><span role="cell">${escapeHtml(seat.email)}</span><span role="cell">${seat.role}</span><span role="cell">${seat.status}</span></div>`,
    )
    .join("\n");

  if (model.variant === "a") {
    return `<section aria-labelledby="seats-heading">
      <h2 id="seats-heading">Seats</h2>
      <table><caption>Seats on this account</caption>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">${model.seats.filter((s) => s.status === "active").length} of ${model.account.seat_limit} seats in use</p>
    </section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="seats-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="seats-heading">Seats</h2></div>
    <div class="c-list" role="table" aria-label="Seats on this account">
      <div class="c-list__row c-list__row--head" role="row">
        <span role="columnheader">Email</span><span role="columnheader">Role</span><span role="columnheader">Status</span>
      </div>
      ${rows}
    </div>
    <p class="c-panel__hint">${model.seats.filter((s) => s.status === "active").length} of ${model.account.seat_limit} seats in use</p>
  </div>`;
}

function invoicesSection(model: PageModel): string {
  const rows = model.invoices
    .map((invoice) =>
      model.variant === "a"
        ? `<tr><td><a href="/invoices/${invoice.id}">${invoice.number}</a></td><td>${money(invoice.amount_cents, invoice.currency)}</td><td>${invoice.status}</td></tr>`
        : `<div class="c-list__row" role="row"><span role="cell"><a class="c-link" href="/invoices/${invoice.id}">${invoice.number}</a></span><span role="cell">${money(invoice.amount_cents, invoice.currency)}</span><span role="cell">${invoice.status}</span></div>`,
    )
    .join("\n");

  if (model.variant === "a") {
    return `<section aria-labelledby="invoices-heading">
      <h2 id="invoices-heading">Invoices</h2>
      <table><caption>Invoices</caption>
        <thead><tr><th>Number</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="invoices-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="invoices-heading">Invoices</h2></div>
    <div class="c-list" role="table" aria-label="Invoices">
      <div class="c-list__row c-list__row--head" role="row">
        <span role="columnheader">Number</span><span role="columnheader">Amount</span><span role="columnheader">Status</span>
      </div>
      ${rows}
    </div>
  </div>`;
}

function ssoSection(model: PageModel): string {
  const checked = model.sso.enabled ? " checked" : "";
  const toggle =
    model.variant === "a"
      ? `<p class="field"><label for="sso_enabled">Require single sign-on</label>
         <input id="sso_enabled" name="sso_enabled" type="checkbox"${checked}></p>`
      : `<div class="c-form__row"><label class="c-form__label" for="sso_enabled">Require single sign-on</label>
         <span class="c-form__control"><input class="c-form__check" id="sso_enabled" name="sso_enabled" type="checkbox"${checked}></span></div>`;

  const domain = field(model.variant, "enforced_domain", "Enforced domain", model.sso.enforced_domain ?? "");

  if (model.variant === "a") {
    return `<section aria-labelledby="sso-heading">
      <h2 id="sso-heading">Single sign-on</h2>
      <form id="sso-form" data-account="${model.account.id}">
        ${toggle}${domain}
        <button type="submit" class="primary">Save single sign-on</button>
        <output id="sso-status" role="status"></output>
      </form>
    </section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="sso-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="sso-heading">Single sign-on</h2></div>
    <form class="c-form" id="sso-form" data-account="${model.account.id}">
      <div class="c-form__grid">${toggle}${domain}</div>
      <div class="c-form__actions">
        <button class="c-btn c-btn--primary" type="submit">Save single sign-on</button>
        <output class="c-form__status" id="sso-status" role="status"></output>
      </div>
    </form>
  </div>`;
}

function accountSection(model: PageModel): string {
  const rows = `
    <dt>Account</dt><dd>${escapeHtml(model.account.name)}</dd>
    <dt>Plan</dt><dd id="account-plan">${model.account.plan}</dd>
    <dt>Seat limit</dt><dd>${model.account.seat_limit}</dd>
    <dt>Tax identifier</dt><dd>${escapeHtml(model.account.tax_id ?? "not set")}</dd>`;

  if (model.variant === "a") {
    return `<section aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2><dl>${rows}</dl></section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="account-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="account-heading">Account</h2></div>
    <dl class="c-facts">${rows}</dl>
  </div>`;
}

function invoiceDetailSection(model: PageModel, invoice: Invoice): string {
  const rows = `
    <dt>Number</dt><dd>${invoice.number}</dd>
    <dt>Amount</dt><dd>${money(invoice.amount_cents, invoice.currency)}</dd>
    <dt>Status</dt><dd>${invoice.status}</dd>
    <dt>Issued</dt><dd>${invoice.issued_at.slice(0, 10)}</dd>`;
  if (model.variant === "a") {
    return `<section aria-labelledby="invoice-heading">
      <h2 id="invoice-heading">Invoice ${invoice.number}</h2><dl>${rows}</dl></section>`;
  }
  return `<div class="c-panel" role="region" aria-labelledby="invoice-heading">
    <div class="c-panel__head"><h2 class="c-panel__title" id="invoice-heading">Invoice ${invoice.number}</h2></div>
    <dl class="c-facts">${rows}</dl></div>`;
}

const NAV = [
  { href: "/account", label: "Account" },
  { href: "/settings/billing", label: "Billing" },
  { href: "/settings/seats", label: "Seats" },
  { href: "/settings/sso", label: "Single sign-on" },
  { href: "/invoices", label: "Invoices" },
];

function chrome(model: PageModel, body: string): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}${model.variant === "b" ? "?variant=b" : ""}"${item.href === model.path ? ' aria-current="page"' : ""}>${item.label}</a>`,
  ).join("\n");

  const widget =
    model.widgetScriptUrl === null || model.widgetProductId === null
      ? ""
      : `<script src="${model.widgetScriptUrl}" id="superguide-widget" data-product-id="${model.widgetProductId}" data-api-url="${model.apiUrl ?? ""}" async></script>`;

  const shell =
    model.variant === "a"
      ? `<header><h1>Northwind Logistics</h1><nav aria-label="Main">${nav}</nav></header>
         <main>${body}</main>
         <footer><p>Variant A</p></footer>`
      : `<div class="l-shell"><div class="l-shell__bar" role="banner"><span class="l-brand">Northwind Logistics</span>
           <div class="l-nav" role="navigation" aria-label="Main">${nav}</div></div>
           <div class="l-shell__body" role="main">${body}</div>
           <div class="l-shell__foot" role="contentinfo"><span>Variant B</span></div></div>`;

  return `<!doctype html>
<html lang="en" data-variant="${model.variant}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)} — Northwind Logistics</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
${shell}
<script src="/app.js" defer></script>
${widget}
</body>
</html>`;
}

export function renderPage(model: PageModel, invoice?: Invoice): string {
  switch (model.path) {
    case "/account":
      return chrome(model, accountSection(model));
    case "/settings/billing":
      return chrome(model, billingSection(model));
    case "/settings/seats":
      return chrome(model, seatsSection(model));
    case "/settings/sso":
      return chrome(model, ssoSection(model));
    case "/invoices":
      return chrome(model, invoicesSection(model));
    default:
      return chrome(
        model,
        invoice === undefined
          ? `<section><h2>Not found</h2><p>No such page.</p></section>`
          : invoiceDetailSection(model, invoice),
      );
  }
}
