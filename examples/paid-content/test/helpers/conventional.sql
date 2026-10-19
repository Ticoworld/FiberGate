-- Alternative design for the SAME online merchant, not an additional live
-- authority. Used only in a test-local isolated schema. No signed receipt is
-- necessary when the application authenticates the owner on every request.
CREATE TABLE conventional_grants (
  order_id text PRIMARY KEY,
  purchaser text NOT NULL,
  resource text NOT NULL,
  policy text NOT NULL,
  paid boolean NOT NULL,
  allowance integer NOT NULL CHECK (allowance = 3),
  used integer NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND allowance),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- After the identical verified payment/binding decision, a conventional host
-- inserts once in its paid-order transaction (same unique order/idempotency
-- protection as the recipe). It can store a random opaque receipt ID if needed.
-- The access decision is a single guarded UPDATE. Postgres rechecks its WHERE
-- predicate after competing writers; one remaining use admits one contender.
-- No preceding read-and-write counter pair, Redis lock or serializable retry.
