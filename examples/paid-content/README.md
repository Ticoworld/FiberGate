# Paid content with FiberGate and FiberLatch

A merchant creates a FiberGate invoice, verifies its payment webhook, persists
one FiberLatch entitlement, and lets the authenticated purchaser retrieve a
signed receipt and download a private file.

This is an **optional merchant integration example**, not a production commerce
system. Its payment tests use **controlled signed fixtures, not real Fiber
settlement**. The simulator provisions no Fiber node or channel and returns
invoice addresses marked `FIXTURE_ONLY_NOT_PAYABLE`.

The [demo storefront](../../apps/demo-storefront) already demonstrates SDK
checkout, QR codes and verified webhook notifications to a browser. This example
adds durable order/payment binding, create-once fulfillment, owner-only receipt
retrieval and an actual private download with a persistent usage allowance. It
uses a scripted purchaser rather than a browser checkout UI.

## Run the example

Requires Node.js **22.12 or newer**, npm, and Docker Compose v2. From the
repository root, in PowerShell or a POSIX shell:

```sh
cd examples/paid-content
npm ci --ignore-scripts
npm run init
docker compose up -d --wait
npm run setup
npm test
```

Run the HTTP demonstration in **three terminals**, all in this directory:

```sh
# Terminal A: controlled invoice/webhook simulator, NOT a Fiber gateway
npm run fixture

# Terminal B: merchant server, bound to 127.0.0.1:3401
npm start

# Terminal C: purchaser order, signed fixture, receipt and four download attempts
npm run demo
```

Expected output: an `awaiting_payment` order; a labelled simulated payment;
three HTTP 200 responses containing the guide; then HTTP 403. The demo never
prints session tokens or signed receipts. A browser success message cannot
fulfill an order.

This directory is outside the repository's pnpm workspace globs. Its npm
lockfile pins published `@fibergate/sdk@0.1.0`, `@fiberlatch/access@0.1.1` and
`@fiberlatch/postgres-store@0.1.0`; it imports no FiberGate core source. Existing
FiberGate installs, dependencies and root builds are unchanged. Merchant source
is strict TypeScript; `npm run typecheck` checks it and `npm run build` emits
ignored `dist/`. Setup/start/fixture/test scripts build before execution.

## Local state and authentication

`npm run init` generates a random PostgreSQL password, independent 256-bit
Alice/Bob bearer sessions, Ed25519 signing keys, and simulator secrets in ignored
`.local/`. It preserves existing files on rerun. No usable credential is checked
in. Keep these files private and preserve the signing key while receipts exist.
On Windows, protect their directory with your account's filesystem permissions;
the POSIX file mode requested by the initializer does not configure Windows ACLs.

Compose starts only a dedicated PostgreSQL database on `127.0.0.1:55434`, with a
persistent Docker volume. `npm run setup` explicitly applies `schema.sql` to
that database and stores hashed session tokens with seven-day expiry. It never
resets orders, receipts or counters, or extends session expiry. This local
session lookup is the example's authentication boundary; replace it with the
merchant's existing identity system before adoption. There is no public login,
signup, token-minting endpoint or expired-session renewal workflow.

All database entry points run a fail-closed, read-only preflight **before any
schema creation or data/test mutation**. The default targets only this example's
local Compose database. For `DATABASE_URL`, the database name must be
`paid_content` or `paid_content_<suffix>` (lowercase letters/digits, underscore
separators), and `PAID_CONTENT_DATABASE_TARGET` must explicitly confirm the exact
`user@host:port/database`, without a password. For example, for a separately
provisioned, empty, exclusively owned database:

```powershell
$env:DATABASE_URL = "postgresql://example_user:<password>@localhost:5432/paid_content_review"
$env:PAID_CONTENT_DATABASE_TARGET = "example_user@localhost:5432/paid_content_review"
```

In a POSIX shell, use `export DATABASE_URL='...'` and
`export PAID_CONTENT_DATABASE_TARGET='...'`. Only the `sslmode` URL query option
is accepted; connection redirects/options are rejected. The preflight checks the
connected database/user and public search path. It permits an empty database or
only the four existing example tables; unrelated user schemas, relations or
routines reject setup, tests and server startup. An interrupted test leaving a
failure-injection routine also requires inspection before another run.

This guard prevents accidental targeting; the confirmation is an operator claim
of exclusive ownership, not automatic detection of production use. Do not point
it at FiberGate's database or a shared/production database, rename such a database
to bypass the guard, or share this database with another application. Run setup
and tests exclusively, without other proof processes making concurrent schema
changes. Tests include intentional, temporary test-only DDL in this dedicated
database. Stop with `docker compose stop`; restarting preserves data. Do not
delete the volume or regenerate keys to recover an order or refill an allowance.

## Purchaser and webhook routes

Purchaser routes require `Authorization: Bearer <session>`; local sessions are in
`.local/accounts.json`. The token identifies the account; no request body selects
the purchaser. Receipt tokens use the separate `X-Access-Receipt` header.

| Request                                                      | Behavior                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `POST /orders`, `Idempotency-Key: <8–80 letters/digits/_/->` | Order the fixed product; one SDK create attempt; return checkout only after durable binding |
| `GET /orders/:id`                                            | Owner-only state and invoice                                                                |
| `POST /webhook`, `X-Fiber-Signature`                         | Verify raw bytes, validate event and stored payment binding, fulfill atomically             |
| `GET /orders/:id/receipt`                                    | Paid owner retrieves the persisted signed receipt, remaining uses and expiry; no refill     |
| `POST /orders/:id/download`, `X-Access-Receipt`              | Authenticate owner, verify receipt, consume allowance atomically, serve private bytes       |

The guide is `private-assets/field-guide.txt`. There is no static/public file
route or redirect to a public object URL. Responses disable caching; range
requests are denied. A receipt alone cannot authorize another account: its
subject, order, resource, policy, maximum and stored authority must match trusted
request context.

## Payment binding and duplicate delivery

The event validator follows `apps/web/lib/webhooks/trigger.ts` on `canary` at
`9fcc793`: `payment.paid` carries `created_at` and `data` containing
`invoice_id`, `payment_hash`, numeric CKB `amount`, `asset`, `paid_at`, and
`metadata`. `verifyWebhookSignature` checks `X-Fiber-Signature` over the raw
UTF-8 body **before JSON parsing**.

The merchant first commits a `creating` order with its purchaser, request key,
fixed price and asset. It calls the published SDK once and persists a validated
invoice UUID/hash/amount/asset binding before exposing checkout. A verified
notification must match that binding; metadata never supplies missing authority.
An unbound notification gets retryable HTTP 503 and grants nothing, including
when delivery races a successful invoice response.

Fulfillment locks the order and commits accepted raw notification/digest, paid
state, and one signed receipt in the same PostgreSQL transaction. Uniqueness
constraints enforce one payment binding and one entitlement per purchase.
Concurrent or repeated notifications acknowledge the existing grant without
changing its JTI, token, expiry or count. Deduplication is by purchase, since the
current event contract emits no event ID.

## Download policy

Price: **1 CKB**. Invoice lifetime: one hour. A purchase allows **three full
download requests within 30 days of fulfillment**. The signed policy is
`three-download-requests-30-days-v1`; retrieval and duplicate events never renew
it. The PostgreSQL store enforces validity, revocation and the shared counter.

This limits server download requests; it is not DRM for a saved file. Reading the
file succeeds before consumption. Consumption commits before returning bytes.
A lost connection or ambiguous database response can spend a use without the
purchaser receiving it. The example does not retry ambiguous consumption or
promise exactly-once HTTP delivery; support/refund policy remains merchant work.

## Limitations and existing invoice-creation issue

- **Existing [issue #93](https://github.com/tiennt0212/FiberGate/issues/93)
  (H01) remains unresolved.** The public create API has no recovery/idempotency
  contract; create/get/list serialization omits merchant metadata. A lost create
  response, malformed response or uncertain persistence leaves `creation_unknown`
  or a stuck `creating` order. The same request key returns 409 without creating
  again. Stop for operator review; do not submit a replacement key, infer a
  binding from metadata, or blindly retry. This example does not solve recovery.
- The SDK has no per-request timeout/AbortSignal option. An in-flight create may
  hang; its durable reservation still blocks another attempt with the same key.
- FiberGate has finite webhook retries. Prolonged failures or unbound invoices
  can require diagnosed, authorized redelivery. Reconciliation and terminal
  invoice-state policy are outside this example.
- No real settlement has been validated for this integration. The runtime
  webhook validator is merchant-owned and must track the upstream event schema.
- Local sessions, keys and loopback servers are teaching defaults, not production
  authentication, key management, deployment or TLS. No refunds, revocation UI,
  renewal, multi-product cart or delivery-support workflow is implemented.

FiberLatch supplies receipt signing/verification/binding checks and atomic
PostgreSQL redemption. The merchant still owns payment trust, authentication,
create-once issuance, schema and file delivery. A conventional authenticated
download server can enforce the same allowance with a guarded SQL update and
may not need signed receipts. No adoption or reduced total effort is claimed.

## Testing and persistence

`npm test` preserves the original 15 acceptance checks (13 integration scenarios,
their enclosing test, and a conventional PostgreSQL control) and adds six database
safety checks (five rejection/override scenarios and their enclosing test), for
21 tests total. The safety tests check actual setup and test-entry rejection,
unchanged rows/catalogue objects, and an explicitly confirmed dedicated override.
The acceptance checks exercise
the actual SDK over HTTP, actual Ed25519 receipts and private file bytes against
real PostgreSQL. Cases include 24 webhook deliveries across two instances,
16 contenders for one remaining download, rollback, unauthorized access,
tampering, ambiguous create, early delivery and a fresh Node process.
The conventional control uses a separate temporary test schema and grants no
second allowance to merchant orders.

Tests use unique order keys and retain orders for inspection. Their explicit
revocation/expiry mutations and temporary failure trigger target test grants;
the trigger is removed in `finally`. Tests require fixture mode and must run
only against a dedicated database.

To check an actual PostgreSQL restart and setup rerun, stop the demo servers and
run these commands in this directory:

```sh
node scripts/restart-check.mjs prepare
docker compose restart postgres
docker compose up -d --wait
npm run setup
node scripts/restart-check.mjs verify
```

The check requires a changed PostgreSQL start time, compares binding, JTI, token
digest, expiry, payment evidence and count, replays a signed fixture without a
refill, then serves the next download. Its receipt and output remain in ignored
`.local/`; no database files, tokens or test evidence enter Git.

## Connecting an existing FiberGate deployment

This mode is provided for adaptation and **has not been settlement-tested**.
Explicitly set `FIBERGATE_MODE=gateway`, `FIBERGATE_BASE_URL` (including
`/api/v1`), `FIBERGATE_INTERNAL_SECRET` and `FIBERGATE_WEBHOOK_SECRET` in the
merchant process environment. Partial configuration is rejected. Register the
merchant's `/webhook` with that endpoint secret on the existing gateway and make
it reachable from the gateway's network. Docker container loopback is not the
host's loopback; the example does not provision a public endpoint or proxy.

The simulator and demo refuse gateway mode. Keep fixtures separate from real
payment evidence. Supply real merchant authentication, secure key operation and
a deployment plan before using this pattern beyond a local example.
