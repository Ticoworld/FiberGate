import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { makePool, root } from "../dist/config.js";
import { conventionalConsume } from "./helpers/conventional.mjs";

test("Conventional PostgreSQL allowance control: ownership, payment, revocation, expiry and concurrent limit", async () => {
  const pool = await makePool();
  // Test-only schema: no duplicate authority/counter for merchant purchases.
  const schema = `paid_content_compare_${randomBytes(8).toString("hex")}`;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO ${schema}`);
      await setup.query(
        await readFile(new URL("test/helpers/conventional.sql", root), "utf8"),
      );
      await setup.query(`INSERT INTO conventional_grants (order_id,purchaser,resource,policy,paid,allowance,expires_at)
        VALUES ('test-only-order','alice','field-guide-v1','three-download-requests-30-days-v1',false,3,now()+interval '30 days')`);
    } finally {
      setup.release();
    }
    const use = async (subject = "alice") => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schema}`);
        return await conventionalConsume(client, {
          orderId: "test-only-order",
          subject,
        });
      } finally {
        client.release();
      }
    };
    assert.equal(await use(), null);
    await pool.query(`UPDATE ${schema}.conventional_grants SET paid=true`);
    assert.equal(await use("bob"), null);
    await pool.query(
      `UPDATE ${schema}.conventional_grants SET revoked_at=now()`,
    );
    assert.equal(await use(), null);
    await pool.query(
      `UPDATE ${schema}.conventional_grants SET revoked_at=NULL,expires_at=now()-interval '1 second'`,
    );
    assert.equal(await use(), null);
    await pool.query(
      `UPDATE ${schema}.conventional_grants SET expires_at=now()+interval '30 days'`,
    );
    assert.equal((await use()).used, 1);
    assert.equal((await use()).used, 2);
    const contenders = await Promise.all(
      Array.from({ length: 16 }, () => use()),
    );
    assert.equal(contenders.filter(Boolean).length, 1);
    assert.equal(contenders.find(Boolean).exhausted, true);
    assert.equal(await use(), null);
    assert.equal(
      (await pool.query(`SELECT used FROM ${schema}.conventional_grants`))
        .rows[0].used,
      3,
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
