CREATE TABLE end_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  external_id   text,
  identity_tier text NOT NULL DEFAULT 'anonymous'
                CHECK (identity_tier IN ('anonymous', 'unverified', 'verified')),
  scopes        text[] NOT NULL DEFAULT '{}',
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, external_id)
);

CREATE TABLE conversation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  end_user_id      uuid NOT NULL REFERENCES end_user (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  resolution_state text NOT NULL DEFAULT 'in_progress'
                   CHECK (resolution_state IN
                     ('in_progress', 'resolved', 'unresolved', 'escalated', 'cancelled')),
  active_turn_id   uuid,
  next_seq         bigint NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);

CREATE INDEX conversation_product_user_idx ON conversation (product_id, end_user_id);
CREATE INDEX conversation_in_flight_idx ON conversation (product_id) WHERE active_turn_id IS NOT NULL;

CREATE TABLE message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         jsonb NOT NULL,
  seq             bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX message_conversation_seq_idx ON message (conversation_id, seq);

CREATE TABLE step (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  turn_id           uuid NOT NULL,
  seq               bigint NOT NULL,
  ladder_level      text NOT NULL CHECK (ladder_level IN ('L1', 'L2', 'L3', 'L4', 'L5', 'L6')),
  action            jsonb NOT NULL,
  policy_verdict    jsonb NOT NULL,
  result            jsonb NOT NULL,
  expect_outcome    jsonb NOT NULL,
  model             text,
  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,
  request_id        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX step_conversation_seq_idx ON step (conversation_id, seq);
CREATE INDEX step_turn_idx ON step (turn_id);
