// Two separate invocations, with docker compose restart postgres between them.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { root, config, makePool } from "../dist/config.js";
import { serve } from "../dist/server.js";
import {
  fixtureGateway,
  paidFixture,
  signFixture,
} from "./fixture-gateway.mjs";

const phase = process.argv[2];
assert.ok(["prepare", "verify"].includes(phase), "Use prepare or verify");
const settings = await config();
assert.equal(settings.mode, "fixture", "Restart check requires fixture mode");
const accounts = JSON.parse(
  await readFile(new URL(".local/accounts.json", root), "utf8"),
);
const pool = await makePool();
const fixture = await fixtureGateway(settings, 0);
const server = await serve(pool, { ...settings, baseUrl: fixture.baseUrl }, 0);
const base = `http://127.0.0.1:${server.address().port}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accounts.alice}`, ...options.headers },
  });
  assert.equal(response.status, options.expectedStatus ?? 200);
  return response.headers.get("content-type").includes("json")
    ? response.json()
    : response.text();
}
async function snapshot(id) {
  const row = (
    await pool.query(
      `SELECT o.id,o.purchaser,o.invoice_id,o.payment_hash,o.status,r.jti,r.token,r.exp,r.redemption_count,p.body_sha256
    FROM merchant_orders o JOIN access_receipts r ON r.intent_id=o.id JOIN accepted_payments p ON p.order_id=o.id WHERE o.id=$1`,
      [id],
    )
  ).rows[0];
  assert.ok(row);
  return { ...row, token: sha(row.token) };
}
try {
  const postmaster = (
    await pool.query("SELECT pg_postmaster_start_time() AS started")
  ).rows[0].started.toISOString();
  if (phase === "prepare") {
    const order = await call("/orders", {
      method: "POST",
      expectedStatus: 201,
      headers: { "Idempotency-Key": `restart-${randomUUID()}` },
    });
    const raw = JSON.stringify(
      paidFixture(fixture.invoices.get(order.invoice.id)),
    );
    await call("/webhook", {
      method: "POST",
      headers: {
        "X-Fiber-Signature": signFixture(raw, settings.webhookSecret),
      },
      body: raw,
    });
    const { receipt } = await call(`/orders/${order.id}/receipt`);
    assert.match(
      await call(`/orders/${order.id}/download`, {
        method: "POST",
        headers: { "X-Access-Receipt": receipt },
      }),
      /Fiber Merchant Field Guide/,
    );
    const before = await snapshot(order.id);
    assert.equal(before.redemption_count, "1");
    await writeFile(
      new URL(".local/restart-case.json", root),
      JSON.stringify(
        { order: order.id, receipt, raw, before, postmaster },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      "Prepared a paid fixture purchase at 1/3. Now restart PostgreSQL, rerun setup, then run verify.",
    );
  } else {
    const saved = JSON.parse(
      await readFile(new URL(".local/restart-case.json", root), "utf8"),
    );
    assert.notEqual(
      postmaster,
      saved.postmaster,
      "PostgreSQL must actually restart between phases",
    );
    const after = await snapshot(saved.order);
    assert.deepEqual(after, saved.before);
    const fetched = await call(`/orders/${saved.order}/receipt`);
    assert.equal(fetched.receipt, saved.receipt);
    assert.equal(fetched.remaining, 2);
    await call("/webhook", {
      method: "POST",
      headers: {
        "X-Fiber-Signature": signFixture(saved.raw, settings.webhookSecret),
      },
      body: saved.raw,
    });
    assert.deepEqual(await snapshot(saved.order), saved.before);
    assert.match(
      await call(`/orders/${saved.order}/download`, {
        method: "POST",
        headers: { "X-Access-Receipt": saved.receipt },
      }),
      /Fiber Merchant Field Guide/,
    );
    const final = await snapshot(saved.order);
    assert.equal(final.redemption_count, "2");
    assert.equal(final.jti, saved.before.jti);
    await writeFile(
      new URL(".local/restart-result.json", root),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          paymentEvidence: "controlled signed fixture; NOT settlement",
          oldPostmaster: saved.postmaster,
          newPostmaster: postmaster,
          before: saved.before,
          afterRestartBeforeUse: after,
          afterSecondDownload: final,
          result:
            "PASS: database restarted, setup rerun, new Node process, same binding/token/JTI/expiry/payment evidence/counter; duplicate did not refill; second download served",
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: PostgreSQL restart + setup reload preserved all authority; duplicate did not refill; second download served at 2/3.",
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fixture.server.close(resolve));
  await pool.end();
}
