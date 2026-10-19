import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  createAccessReceiptSigner,
  createAccessReceiptVerifier,
} from "@fiberlatch/access";
import { config, makePool, root } from "../dist/config.js";
import { serve } from "../dist/server.js";
import {
  paidFixture,
  signFixture,
  fixtureGateway,
} from "../scripts/fixture-gateway.mjs";

test("FiberGate SDK → verified fixture → durable FiberLatch paid download (PostgreSQL)", async (t) => {
  const settings = await config();
  assert.equal(
    settings.mode,
    "fixture",
    "Integration tests require fixture mode",
  );
  const accounts = JSON.parse(
    await readFile(new URL(".local/accounts.json", root), "utf8"),
  );
  const pool = await makePool(),
    pool2 = await makePool();
  const fixture = await fixtureGateway(settings, 0);
  settings.baseUrl = fixture.baseUrl;
  const servers = [
    await serve(pool, settings, 0),
    await serve(pool2, settings, 0),
  ];
  const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  const run = `test-${randomUUID()}`;
  t.after(async () => {
    for (const server of [...servers, fixture.server])
      await new Promise((resolve) => server.close(resolve));
    await Promise.all([pool.end(), pool2.end()]);
  });
  const check = (name, fn) => t.test(name, fn);
  async function request(
    path,
    {
      user = "alice",
      token,
      headers = {},
      method = "GET",
      raw,
      instance = 0,
    } = {},
  ) {
    const response = await fetch(`${urls[instance]}${path}`, {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${accounts[user]}` } : {}),
        ...(token ? { "X-Access-Receipt": token } : {}),
        ...headers,
      },
      body: raw,
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      data: response.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : null,
    };
  }
  const order = async (key = `${run}-${randomUUID()}`, user = "alice") =>
    request("/orders", {
      method: "POST",
      user,
      headers: { "Idempotency-Key": key },
    });
  const webhook = (event, instance = 0, signature) => {
    const raw = typeof event === "string" ? event : JSON.stringify(event);
    return request("/webhook", {
      method: "POST",
      user: null,
      instance,
      raw,
      headers: {
        "X-Fiber-Signature":
          signature ?? signFixture(raw, settings.webhookSecret),
      },
    });
  };
  const getReceipt = (id) => request(`/orders/${id}/receipt`);
  const download = (id, token, options = {}) =>
    request(`/orders/${id}/download`, { method: "POST", token, ...options });
  const state = async (id) =>
    (
      await pool.query(
        `SELECT o.status, r.jti,r.token,r.redemption_count,r.exp,
    (SELECT count(*)::int FROM accepted_payments WHERE order_id=o.id) AS payments,
    (SELECT count(*)::int FROM access_receipts WHERE intent_id=o.id) AS grants
    FROM merchant_orders o LEFT JOIN access_receipts r ON r.intent_id=o.id WHERE o.id=$1`,
        [id],
      )
    ).rows[0];
  let main, paid, receipt, firstState;

  await check(
    "Real SDK HTTP create; durable purchaser/order/invoice/hash/amount binding; checkout alone grants nothing",
    async () => {
      const response = await order(`${run}-main`);
      assert.equal(response.status, 201);
      main = response.data;
      assert.match(main.invoice.invoice_address, /^FIXTURE_ONLY_NOT_PAYABLE_/);
      const saved = (
        await pool.query("SELECT * FROM merchant_orders WHERE id=$1", [main.id])
      ).rows[0];
      assert.equal(saved.purchaser, "alice");
      assert.equal(saved.invoice_id, main.invoice.id);
      assert.equal(saved.payment_hash, main.invoice.payment_hash);
      assert.equal(saved.amount_ckb, 1);
      assert.equal((await getReceipt(main.id)).status, 409);
      assert.equal((await download(main.id, "browser-says-paid")).status, 403);
      assert.equal((await state(main.id)).grants, 0);
      const before = fixture.control.creates;
      const repeated = await Promise.all(
        Array.from({ length: 8 }, () => order(`${run}-main`)),
      );
      assert.ok(repeated.every((r) => r.data.id === main.id));
      assert.equal(fixture.control.creates, before);
      paid = paidFixture(fixture.invoices.get(main.invoice.id));
    },
  );
  await check(
    "Missing/invalid/tampered raw-body HMAC, malformed schema and browser-success event cannot grant",
    async () => {
      const raw = JSON.stringify(paid);
      assert.equal(
        (await request("/webhook", { method: "POST", user: null, raw })).status,
        401,
      );
      assert.equal((await webhook(paid, 0, "sha256=bad")).status, 401);
      assert.equal(
        (await webhook(`${raw} `, 0, signFixture(raw, settings.webhookSecret)))
          .status,
        401,
      );
      assert.equal((await webhook("{")).status, 400);
      assert.equal(
        (
          await webhook({
            event: "payment.paid",
            data: { invoice_id: main.invoice.id },
          })
        ).status,
        400,
      );
      assert.equal(
        (await webhook({ event: "browser.success", data: paid.data })).data
          .ignored,
        true,
      );
      assert.equal((await state(main.id)).grants, 0);
    },
  );
  await check(
    "Signed events require exact persisted invoice/hash/asset/amount; metadata cannot grant an unknown invoice",
    async () => {
      for (const change of [
        { payment_hash: `0x${"a".repeat(64)}` },
        { asset: "RUSD" },
        { amount: 2 },
      ]) {
        assert.equal(
          (await webhook({ ...paid, data: { ...paid.data, ...change } }))
            .status,
          422,
        );
      }
      assert.equal(
        (
          await webhook({
            ...paid,
            data: {
              ...paid.data,
              invoice_id: randomUUID(),
              metadata: { order_id: main.id },
            },
          })
        ).status,
        503,
      );
      assert.equal((await state(main.id)).grants, 0);
    },
  );
  await check(
    "Fulfillment transaction failure rolls back accepted payment, order state and entitlement; retry can complete",
    async () => {
      // Failure injection affects only this run's specific order and is removed.
      await pool.query(`CREATE OR REPLACE FUNCTION paid_content_test_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.intent_id = '${main.id}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await pool.query(
        "CREATE TRIGGER paid_content_test_failure BEFORE INSERT ON access_receipts FOR EACH ROW EXECUTE FUNCTION paid_content_test_insert_failure()",
      );
      try {
        assert.equal((await webhook(paid)).status, 503);
        const s = await state(main.id);
        assert.equal(s.status, "awaiting_payment");
        assert.equal(s.payments, 0);
        assert.equal(s.grants, 0);
      } finally {
        await pool.query(
          "DROP TRIGGER paid_content_test_failure ON access_receipts",
        );
        await pool.query("DROP FUNCTION paid_content_test_insert_failure()");
      }
    },
  );
  await check(
    "24 concurrent deliveries across two instances produce exactly one committed payment and entitlement",
    async () => {
      const deliveries = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          webhook(
            { ...paid, created_at: new Date(Date.now() + i).toISOString() },
            i % 2,
          ),
        ),
      );
      assert.ok(deliveries.every((r) => r.status === 200));
      assert.equal(
        deliveries.filter((r) => r.data.duplicate === false).length,
        1,
      );
      firstState = await state(main.id);
      assert.equal(firstState.status, "paid");
      assert.equal(firstState.grants, 1);
      assert.equal(firstState.payments, 1);
      assert.equal(firstState.redemption_count, "0");
      const response = await getReceipt(main.id);
      assert.equal(response.status, 200);
      receipt = response.data.receipt;
      const verify = await createAccessReceiptVerifier({
        publicKeys: [settings.publicKey],
        issuer: "urn:fibergate:paid-content",
        audience: "fibergate-paid-content",
      });
      const claims = await verify(receipt);
      assert.equal(claims.sub, "alice");
      assert.equal(claims.intent_id, main.id);
      assert.equal(claims.payment_ref, main.invoice.payment_hash);
      assert.equal(claims.max_redemptions, 3);
      assert.equal(claims.exp - claims.iat, 30 * 86400);
    },
  );
  await check(
    "Unauthenticated and unrelated accounts cannot retrieve or use the receipt; no static asset URL",
    async () => {
      assert.equal(
        (await request(`/orders/${main.id}/receipt`, { user: null })).status,
        401,
      );
      assert.equal(
        (await request(`/orders/${main.id}/receipt`, { user: "bob" })).status,
        404,
      );
      assert.equal(
        (await download(main.id, receipt, { user: "bob" })).status,
        404,
      );
      assert.equal(
        (await download(main.id, receipt, { user: null })).status,
        401,
      );
      assert.equal(
        (await request("/private-assets/field-guide.txt")).status,
        404,
      );
      assert.equal(
        (await request("/field-guide.txt", { user: null })).status,
        401,
      );
      assert.equal(
        (await download(main.id, `${receipt.slice(0, -8)}tampered`)).status,
        403,
      );
      assert.equal(
        (await download(main.id, receipt, { headers: { Range: "bytes=0-9" } }))
          .status,
        416,
      );
      assert.equal((await state(main.id)).redemption_count, "0");
    },
  );
  await check(
    "Protected bytes served; repeated receipt retrieval and duplicate payment preserve JTI, token, expiry and remaining uses",
    async () => {
      const response = await download(main.id, receipt);
      assert.equal(response.status, 200);
      assert.equal(
        response.text,
        await readFile(new URL("private-assets/field-guide.txt", root), "utf8"),
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await webhook(paid)).status, 200);
      const retrieved = await getReceipt(main.id);
      assert.equal(retrieved.data.receipt, receipt);
      assert.equal(retrieved.data.remaining, 2);
      const s = await state(main.id);
      assert.equal(s.jti, firstState.jti);
      assert.equal(s.exp, firstState.exp);
      assert.equal(s.redemption_count, "1");
    },
  );
  await check(
    "Fresh Node process reload retrieves same receipt and counter from PostgreSQL and existing signing keys",
    async () => {
      const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: root,
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const url = await new Promise((resolve, reject) => {
          let output = "";
          const timer = setTimeout(
            () => reject(new Error("Child startup timeout")),
            10000,
          );
          child.stdout.on("data", (data) => {
            output += data;
            const m = /http:\/\/127.0.0.1:\d+/.exec(output);
            if (m) {
              clearTimeout(timer);
              resolve(m[0]);
            }
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Child exited ${code}`));
          });
        });
        const response = await fetch(`${url}/orders/${main.id}/receipt`, {
          headers: { Authorization: `Bearer ${accounts.alice}` },
        });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.receipt, receipt);
        assert.equal(data.remaining, 2);
        const downloaded = await fetch(`${url}/orders/${main.id}/download`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accounts.alice}`,
            "X-Access-Receipt": receipt,
          },
        });
        assert.equal(downloaded.status, 200);
        await downloaded.text();
        assert.equal((await state(main.id)).redemption_count, "2");
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  );
  await check(
    "16 concurrent requests for the final use return protected content once; exhausted receipt stays exhausted after webhook replay",
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          download(main.id, receipt, { instance: i % 2 }),
        ),
      );
      assert.equal(responses.filter((r) => r.status === 200).length, 1);
      assert.ok(
        responses
          .filter((r) => r.status !== 200)
          .every((r) => r.status === 403),
      );
      assert.equal((await state(main.id)).redemption_count, "3");
      assert.equal((await webhook(paid)).status, 200);
      assert.equal((await download(main.id, receipt)).status, 403);
      assert.equal((await getReceipt(main.id)).data.remaining, 0);
    },
  );
  await check(
    "Early webhook before binding is retryable and never trusts metadata; later delivery grants once",
    async () => {
      let early;
      fixture.control.beforeResponse = async (invoice) => {
        early = await webhook(paidFixture(invoice));
      };
      let response;
      try {
        response = await order(`${run}-early`);
      } finally {
        fixture.control.beforeResponse = null;
      }
      assert.equal(early.status, 503);
      assert.equal(response.status, 201);
      assert.equal((await state(response.data.id)).grants, 0);
      assert.equal(
        (
          await webhook(
            paidFixture(fixture.invoices.get(response.data.invoice.id)),
          )
        ).status,
        200,
      );
      assert.equal((await state(response.data.id)).grants, 1);
    },
  );
  await check(
    "Ambiguous disconnect, API failure and malformed create response stop without a blind retry",
    async () => {
      for (const failure of ["disconnect", "api-error", "malformed"]) {
        const key = `${run}-${failure}`,
          before = fixture.control.creates;
        fixture.control.nextFailure = failure;
        const response = await order(key);
        assert.equal(response.status, 409);
        const id = response.data.details.orderId;
        assert.equal((await state(id)).status, "creation_unknown");
        assert.equal((await order(key)).status, 409);
        assert.equal(fixture.control.creates, before + 1);
        assert.equal((await getReceipt(id)).status, 409);
        assert.equal((await state(id)).grants, 0);
      }
      const key = `${run}-crashed-creating`;
      await pool.query(
        "INSERT INTO merchant_orders (id,purchaser,request_key,status,amount_ckb,asset) VALUES ($1,'alice',$2,'creating',1,'CKB')",
        [randomUUID(), key],
      );
      const before = fixture.control.creates;
      assert.equal((await order(key)).status, 409);
      assert.equal(fixture.control.creates, before);
    },
  );
  await check(
    "Concurrent first checkout requests create one invoice; same request key is scoped to authenticated account",
    async () => {
      const key = `${run}-concurrent`,
        before = fixture.control.creates;
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => order(key)),
      );
      assert.equal(fixture.control.creates, before + 1);
      assert.ok(responses.every((r) => [201, 409].includes(r.status)));
      const success = responses.find((r) => r.status === 201);
      assert.ok(success);
      assert.equal((await order(key)).data.id, success.data.id);
      const other = await order(key, "bob");
      assert.equal(other.status, 201);
      assert.notEqual(other.data.id, success.data.id);
    },
  );
  await check(
    "Another owned order cannot use the first receipt; revocation, persisted expiry and altered authority fail closed",
    async () => {
      const another = (await order()).data;
      await webhook(paidFixture(fixture.invoices.get(another.invoice.id)));
      const token = (await getReceipt(another.id)).data.receipt;
      assert.equal((await download(another.id, receipt)).status, 403);
      await pool.query(
        "UPDATE access_receipts SET revoked_at=now() WHERE intent_id=$1",
        [another.id],
      );
      assert.equal((await download(another.id, token)).status, 403);
      const expOrder = (await order()).data;
      await webhook(paidFixture(fixture.invoices.get(expOrder.invoice.id)));
      const expToken = (await getReceipt(expOrder.id)).data.receipt;
      const signer = await createAccessReceiptSigner({
        privateKey: settings.privateKey,
      });
      const claims = JSON.parse(
        Buffer.from(expToken.split(".")[1], "base64url"),
      );
      assert.equal(
        (
          await download(
            expOrder.id,
            await signer({ ...claims, resource_id: "another-resource" }),
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await download(
            expOrder.id,
            await signer({ ...claims, iat: 1, nbf: 1, exp: 2 }),
          )
        ).status,
        403,
      );
      await pool.query(
        "UPDATE access_receipts SET iat=1,nbf=1,exp=2 WHERE intent_id=$1",
        [expOrder.id],
      );
      assert.equal((await download(expOrder.id, expToken)).status, 403);
      assert.equal((await state(expOrder.id)).redemption_count, "0");
    },
  );
});
