import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { AccessReceiptJwk } from "@fiberlatch/access";

export const root = new URL("../", import.meta.url);
interface LocalKeys {
  privateKey: AccessReceiptJwk;
  publicKey: AccessReceiptJwk;
  fixtureInternalSecret: string;
  fixtureWebhookSecret: string;
}
export interface Settings extends LocalKeys {
  mode: "fixture" | "gateway";
  baseUrl: string;
  internalSecret: string;
  webhookSecret: string;
}
export async function makePool(): Promise<pg.Pool> {
  const overridden = process.env.DATABASE_URL !== undefined;
  let connectionString = process.env.DATABASE_URL;
  if (!overridden) {
    // init.mjs writes these fixed names and a random hexadecimal password.
    // This is deliberately not a general dotenv parser.
    const variables = Object.fromEntries(
      readFileSync(new URL(".local/database.env", root), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.trim().split("=")),
    );
    const url = new URL("postgres://127.0.0.1:55434/paid_content");
    url.username = variables.POSTGRES_USER;
    url.password = variables.POSTGRES_PASSWORD;
    connectionString = url.href;
  }
  // An override is an explicit claim of exclusive ownership, tied to one
  // password-free target. Never print the connection string or its password.
  let target: URL;
  try {
    target = new URL(connectionString ?? "");
  } catch {
    throw new Error("Database safety: invalid database URL");
  }
  const database = decodeURIComponent(target.pathname.slice(1));
  const user = decodeURIComponent(target.username);
  const identity = `${user}@${target.hostname}:${target.port || "5432"}/${database}`;
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !target.hostname ||
    !user ||
    target.hash ||
    !/^paid_content(?:_[a-z0-9]+)*$/.test(database) ||
    [...target.searchParams.keys()].some((key) => key !== "sslmode")
  ) {
    throw new Error(
      "Database safety: use a dedicated paid_content[_suffix] database; only sslmode URL options are supported",
    );
  }
  if (overridden && process.env.PAID_CONTENT_DATABASE_TARGET !== identity) {
    throw new Error(
      "Database safety: DATABASE_URL requires PAID_CONTENT_DATABASE_TARGET=user@host:port/database for that exact dedicated target",
    );
  }
  // Pin the default port too; do not let an inherited PGPORT redirect it.
  target.port ||= "5432";
  const pool = new pg.Pool({
    connectionString: target.href,
    max: 16,
    connectionTimeoutMillis: 5000,
  });
  try {
    const client = await pool.connect();
    try {
      // This preflight cannot create a schema, trigger, row or marker. It runs
      // before the caller receives its pool, including setup and both test files.
      await client.query("BEGIN READ ONLY");
      const {
        rows: [actual],
      } = await client.query<{
        database: string;
        role: string;
        schemas: string[];
        unrelated: boolean;
      }>(`
        SELECT current_database() AS database, current_user AS role,
          current_schemas(false)::text[] AS schemas,
          (EXISTS (
            SELECT FROM pg_namespace WHERE nspname !~ '^pg_'
              AND nspname NOT IN ('public', 'information_schema')
          ) OR EXISTS (
            SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
              AND c.relkind IN ('r','p','v','m','f','S')
              AND NOT (n.nspname='public' AND c.relkind='r' AND c.relname IN
                ('merchant_accounts','merchant_orders','accepted_payments','access_receipts'))
          ) OR EXISTS (
            SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          )) AS unrelated`);
      if (
        actual.database !== database ||
        actual.role !== user ||
        actual.schemas.length !== 1 ||
        actual.schemas[0] !== "public" ||
        actual.unrelated
      ) {
        throw new Error(
          "Database safety: connected identity/search path differs or database contains unrelated schemas, relations or routines; refusing all mutations",
        );
      }
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
export async function config(): Promise<Settings> {
  const keys: LocalKeys = JSON.parse(
    await readFile(new URL(".local/keys.json", root), "utf8"),
  );
  const mode = process.env.FIBERGATE_MODE ?? "fixture";
  if (mode !== "fixture" && mode !== "gateway")
    throw new Error("FIBERGATE_MODE must be fixture or gateway");
  const names = [
    "FIBERGATE_BASE_URL",
    "FIBERGATE_INTERNAL_SECRET",
    "FIBERGATE_WEBHOOK_SECRET",
  ];
  if (mode === "fixture" && names.some((name) => process.env[name])) {
    throw new Error(
      "Gateway configuration requires explicit FIBERGATE_MODE=gateway",
    );
  }
  if (mode === "gateway" && names.some((name) => !process.env[name])) {
    throw new Error(
      "Gateway mode requires explicit base URL, internal secret and webhook secret",
    );
  }
  return {
    ...keys,
    mode,
    baseUrl: process.env.FIBERGATE_BASE_URL ?? "http://127.0.0.1:3402/api/v1",
    internalSecret:
      process.env.FIBERGATE_INTERNAL_SECRET ?? keys.fixtureInternalSecret,
    webhookSecret:
      process.env.FIBERGATE_WEBHOOK_SECRET ?? keys.fixtureWebhookSecret,
  };
}
