import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { root, makePool } from "../dist/config.js";

const accounts = JSON.parse(
  await readFile(new URL(".local/accounts.json", root), "utf8"),
);
const pool = await makePool();
try {
  // Explicit host migration: only use the dedicated example database.
  await pool.query(await readFile(new URL("schema.sql", root), "utf8"));
  for (const [id, token] of Object.entries(accounts)) {
    await pool.query(
      `INSERT INTO merchant_accounts VALUES ($1,$2,now()+interval '7 days')
      ON CONFLICT (id) DO NOTHING`,
      [id, createHash("sha256").update(token).digest("hex")],
    );
  }
  console.log(
    "Schema and local accounts ready. Existing orders, grants, counters and session expiry preserved.",
  );
} finally {
  await pool.end();
}
