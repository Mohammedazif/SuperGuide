import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const tenant = pgTable("tenant", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const product = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    originAllowlist: text("origin_allowlist").array().notNull(),
    jwksUrl: text("jwks_url"),
    jwtIssuer: text("jwt_issuer"),
    jwtAudience: text("jwt_audience"),
    jwtAlgorithms: text("jwt_algorithms").array().notNull(),
    routeRegistry: jsonb("route_registry").notNull(),
    redactionAllowlist: jsonb("redaction_allowlist").notNull(),
    groundedActionsEnabled: boolean("grounded_actions_enabled").notNull(),
    retentionDays: integer("retention_days").notNull(),
    apiBaseUrl: text("api_base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("product_tenant_idx").on(table.tenantId)],
);

export const productSecret = pgTable("product_secret", {
  productId: uuid("product_id").primaryKey(),
  apiCredentialsCiphertext: bytea("api_credentials_ciphertext"),
  apiCredentialsIv: bytea("api_credentials_iv"),
  signingPublicKey: text("signing_public_key"),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

export const procedure = pgTable(
  "procedure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    sourceYaml: text("source_yaml").notNull(),
    active: boolean("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [uniqueIndex("procedure_slug_version_key").on(table.productId, table.slug, table.version)],
);

export const tool = pgTable(
  "tool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    riskClass: text("risk_class").notNull(),
    definition: jsonb("definition").notNull(),
    expectTemplate: jsonb("expect_template").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => [uniqueIndex("tool_product_name_key").on(table.productId, table.name)],
);

export const document = pgTable("document", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceUrl: text("source_url"),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }),
});

export const chunk = pgTable(
  "chunk",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    productId: uuid("product_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    injectionVerdict: text("injection_verdict").notNull(),
  },
  (table) => [index("chunk_product_idx").on(table.productId)],
);

export const endUser = pgTable("end_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull(),
  externalId: text("external_id"),
  identityTier: text("identity_tier").notNull(),
  scopes: text("scopes").array().notNull(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    endUserId: uuid("end_user_id").notNull(),
    status: text("status").notNull(),
    resolutionState: text("resolution_state").notNull(),
    activeTurnId: uuid("active_turn_id"),
    nextSeq: bigint("next_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [index("conversation_product_user_idx").on(table.productId, table.endUserId)],
);

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    productId: uuid("product_id").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("message_conversation_seq_key").on(table.conversationId, table.seq)],
);

export const step = pgTable(
  "step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    productId: uuid("product_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ladderLevel: text("ladder_level").notNull(),
    action: jsonb("action").notNull(),
    policyVerdict: jsonb("policy_verdict").notNull(),
    result: jsonb("result").notNull(),
    expectOutcome: jsonb("expect_outcome").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("step_conversation_seq_key").on(table.conversationId, table.seq)],
);

export const schema = {
  tenant,
  product,
  productSecret,
  procedure,
  tool,
  document,
  chunk,
  endUser,
  conversation,
  message,
  step,
};
