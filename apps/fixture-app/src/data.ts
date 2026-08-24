import { z } from "zod";

export const billingAddressSchema = z.object({
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  postal_code: z.string(),
  country: z.string().length(2),
});
export type BillingAddress = z.infer<typeof billingAddressSchema>;

export interface Account {
  id: string;
  name: string;
  plan: "starter" | "growth" | "scale";
  seat_limit: number;
  billing_address: BillingAddress;
  tax_id: string | null;
  registration_number: string | null;
}

export interface Seat {
  id: string;
  account_id: string;
  email: string;
  role: "owner" | "billing_admin" | "member";
  status: "active" | "invited" | "removed";
}

export interface Invoice {
  id: string;
  account_id: string;
  number: string;
  amount_cents: number;
  currency: string;
  status: "paid" | "open" | "void";
  issued_at: string;
}

export interface SsoSettings {
  account_id: string;
  enabled: boolean;
  provider: "saml" | "oidc" | null;
  metadata_url: string | null;
  enforced_domain: string | null;
}

export interface FixtureState {
  accounts: Map<string, Account>;
  seats: Map<string, Seat>;
  invoices: Map<string, Invoice>;
  sso: Map<string, SsoSettings>;
}

export const SEED_ACCOUNT_ID = "acct_01HQ8G7Z2K";

export function seedState(): FixtureState {
  const accounts = new Map<string, Account>();
  const seats = new Map<string, Seat>();
  const invoices = new Map<string, Invoice>();
  const sso = new Map<string, SsoSettings>();

  accounts.set(SEED_ACCOUNT_ID, {
    id: SEED_ACCOUNT_ID,
    name: "Northwind Logistics",
    plan: "growth",
    seat_limit: 25,
    billing_address: {
      line1: "18 Harbour Road",
      line2: null,
      city: "Bristol",
      postal_code: "BS1 4TT",
      country: "GB",
    },
    tax_id: "GB123456789",
    registration_number: null,
  });

  const seatRows: Seat[] = [
    { id: "seat_001", account_id: SEED_ACCOUNT_ID, email: "dana@northwind.example", role: "owner", status: "active" },
    { id: "seat_002", account_id: SEED_ACCOUNT_ID, email: "ray@northwind.example", role: "billing_admin", status: "active" },
    { id: "seat_003", account_id: SEED_ACCOUNT_ID, email: "kim@northwind.example", role: "member", status: "active" },
    { id: "seat_004", account_id: SEED_ACCOUNT_ID, email: "sasha@northwind.example", role: "member", status: "invited" },
  ];
  for (const seat of seatRows) seats.set(seat.id, seat);

  const invoiceRows: Invoice[] = [
    { id: "inv_2026_04", account_id: SEED_ACCOUNT_ID, number: "NW-2026-04", amount_cents: 49900, currency: "GBP", status: "paid", issued_at: "2026-04-01T00:00:00Z" },
    { id: "inv_2026_05", account_id: SEED_ACCOUNT_ID, number: "NW-2026-05", amount_cents: 49900, currency: "GBP", status: "paid", issued_at: "2026-05-01T00:00:00Z" },
    { id: "inv_2026_06", account_id: SEED_ACCOUNT_ID, number: "NW-2026-06", amount_cents: 62400, currency: "GBP", status: "open", issued_at: "2026-06-01T00:00:00Z" },
  ];
  for (const invoice of invoiceRows) invoices.set(invoice.id, invoice);

  sso.set(SEED_ACCOUNT_ID, {
    account_id: SEED_ACCOUNT_ID,
    enabled: false,
    provider: null,
    metadata_url: null,
    enforced_domain: null,
  });

  return { accounts, seats, invoices, sso };
}
