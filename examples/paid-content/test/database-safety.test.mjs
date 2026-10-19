import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makePool, root } from "../dist/config.js";

const execute = promisify(execFile);
const pool = await makePool();
const url = new URL(pool.options.connectionString);
const target = `${decodeURIComponent(url.username)}@${url.hostname}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
const environment = {
  ...process.env,
  DATABASE_URL: url.href,
  PAID_CONTENT_DATABASE_TARGET: target,
  FIBERGATE_MODE: "fixture",
};
async function child(args, overrides = {}, rejected = true) {
  const env = { ...environment, ...overrides };
  // A nested node --test must start a real independent runner, not inherit
  // the parent's internal child-runner protocol and silently skip its file.
  delete env.NODE_TEST_CONTEXT;
  const result = await execute(process.execPath, args, {
    cwd: root,
    env,
    timeout: 30000,
  }).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );
  assert.equal(result.code, rejected ? 1 : 0, "Unexpected child exit status");
  if (rejected)
    assert.match(`${result.stdout}${result.stderr}`, /Database safety:/);
}

async function snapshot() {
  // Compare catalogue and row versions, without exposing any stored credentials.
  const { rows } = await pool.query(`
    SELECT 'relation' AS kind,n.nspname AS schema,c.relname AS name,NULL::text AS version
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'schema',nspname,'',NULL FROM pg_namespace
      WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    UNION ALL SELECT 'routine',n.nspname,p.proname,NULL
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'row','public','merchant_accounts',xmin::text FROM merchant_accounts
    UNION ALL SELECT 'row','public','merchant_orders',xmin::text FROM merchant_orders
    UNION ALL SELECT 'row','public','accepted_payments',xmin::text FROM accepted_payments
    UNION ALL SELECT 'row','public','access_receipts',xmin::text FROM access_receipts
    ORDER BY 1,2,3,4`);
  return rows;
}

test("Database safety preflight rejects unsafe targets before setup or acceptance mutations", async (t) => {
  t.after(() => pool.end());
  await t.test(
    "Override needs exact dedicated-target confirmation; setup and both acceptance files fail closed",
    async () => {
      const before = await snapshot();
      for (const args of [
        ["scripts/setup.mjs"],
        ["--test", "test/conventional.test.mjs"],
        ["--test", "test/integration.test.mjs"],
      ]) {
        await child(args, { PAID_CONTENT_DATABASE_TARGET: "" });
      }
      await child(["scripts/setup.mjs"], {
        PAID_CONTENT_DATABASE_TARGET: `${target}_wrong`,
      });
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    "Empty, non-example and redirected URLs cannot authorize a database",
    async () => {
      const before = await snapshot();
      await child(["scripts/setup.mjs"], { DATABASE_URL: "" });
      const wrong = new URL(url);
      wrong.pathname = "/postgres";
      await child(["scripts/setup.mjs"], {
        DATABASE_URL: wrong.href,
        PAID_CONTENT_DATABASE_TARGET: `${decodeURIComponent(url.username)}@${url.hostname}:${url.port || "5432"}/postgres`,
      });
      const redirected = new URL(url);
      redirected.searchParams.set("options", "-c search_path=pg_catalog");
      await child(["scripts/setup.mjs"], { DATABASE_URL: redirected.href });
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    "An explicitly confirmed dedicated DATABASE_URL remains supported",
    async () => {
      const before = await snapshot();
      await child(
        [
          "--input-type=module",
          "-e",
          'const {makePool}=await import("./dist/config.js");const pool=await makePool();await pool.end();',
        ],
        {},
        false,
      );
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    "Unrelated table, schema or routine blocks setup and tests without changing any rows or catalogue objects",
    async () => {
      for (const [create, drop] of [
        [
          "CREATE TABLE public.paid_content_safety_probe (id integer)",
          "DROP TABLE public.paid_content_safety_probe",
        ],
        [
          "CREATE SCHEMA paid_content_safety_probe",
          "DROP SCHEMA paid_content_safety_probe",
        ],
        [
          "CREATE FUNCTION public.paid_content_safety_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
          "DROP FUNCTION public.paid_content_safety_probe()",
        ],
      ]) {
        // This parent pool already passed the guard for the dedicated test DB.
        // Each probe is removed even when an assertion fails; no CASCADE is used.
        await pool.query(create);
        try {
          const before = await snapshot();
          for (const args of [
            ["scripts/setup.mjs"],
            ["--test", "test/conventional.test.mjs"],
            ["--test", "test/integration.test.mjs"],
          ])
            await child(args);
          assert.deepEqual(await snapshot(), before);
        } finally {
          await pool.query(drop);
        }
      }
    },
  );
  await t.test(
    "An inherited non-public search path is rejected before setup writes",
    async () => {
      const before = await snapshot();
      await child(["scripts/setup.mjs"], {
        PGOPTIONS: "-c search_path=pg_catalog",
      });
      assert.deepEqual(await snapshot(), before);
    },
  );
});
