-- Dedicated example database only. Host owns migrations and fulfillment.
CREATE TABLE IF NOT EXISTS merchant_accounts (
  id text PRIMARY KEY,
  session_hash text UNIQUE NOT NULL,
  session_expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_orders (
  id text PRIMARY KEY,
  purchaser text NOT NULL REFERENCES merchant_accounts(id),
  request_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('creating','creation_unknown','awaiting_payment','paid')),
  amount_ckb integer NOT NULL CHECK (amount_ckb = 1),
  asset text NOT NULL CHECK (asset = 'CKB'),
  invoice_id text UNIQUE,
  payment_hash text UNIQUE,
  invoice jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchaser, request_key),
  CHECK ((invoice_id IS NULL) = (payment_hash IS NULL)),
  CHECK (status NOT IN ('awaiting_payment','paid') OR invoice IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS accepted_payments (
  order_id text PRIMARY KEY REFERENCES merchant_orders(id),
  invoice_id text UNIQUE NOT NULL,
  raw_body text NOT NULL,
  body_sha256 text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
-- Fixed relation contract required by @fiberlatch/postgres-store.
-- One authority/counter, no shadow entitlement ledger.
CREATE TABLE IF NOT EXISTS public.access_receipts (
  jti text PRIMARY KEY,
  iss text NOT NULL,
  sub text NOT NULL REFERENCES merchant_accounts(id),
  aud text NOT NULL,
  intent_id text UNIQUE NOT NULL REFERENCES merchant_orders(id),
  resource_id text NOT NULL,
  policy_id text NOT NULL,
  grant_type text NOT NULL CHECK (grant_type = 'multi_redemption'),
  max_redemptions bigint NOT NULL CHECK (max_redemptions = 3),
  redemption_count bigint NOT NULL DEFAULT 0 CHECK (redemption_count >= 0 AND redemption_count <= max_redemptions),
  iat bigint NOT NULL,
  nbf bigint NOT NULL,
  exp bigint NOT NULL,
  payment_ref text UNIQUE NOT NULL,
  revoked_at timestamptz,
  token text NOT NULL,
  CHECK (iat <= nbf AND nbf < exp)
);
