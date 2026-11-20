CREATE TABLE IF NOT EXISTS cet_users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cet_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES cet_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cet_sessions_expiry ON cet_sessions (expires_at);
CREATE TABLE IF NOT EXISTS cet_progress (
 user_id uuid PRIMARY KEY REFERENCES cet_users(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0, document jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS cet_receipts (
 user_id uuid NOT NULL REFERENCES cet_users(id) ON DELETE CASCADE,
 op_id uuid NOT NULL, PRIMARY KEY (user_id, op_id)
);
