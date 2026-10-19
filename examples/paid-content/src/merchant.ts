import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FiberGate, verifyWebhookSignature } from "@fibergate/sdk";
import {
  buildAccessReceiptClaims,
  createAccessReceiptSigner,
  createAccessReceiptVerifier,
  redeemAccessReceipt,
} from "@fiberlatch/access";
import { createPostgresAccessReceiptStore } from "@fiberlatch/postgres-store";
import { root, type Settings } from "./config.js";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Invoice } from "@fibergate/sdk";

interface OrderRow extends QueryResultRow {
  id: string;
  purchaser: string;
  status: "creating" | "creation_unknown" | "awaiting_payment" | "paid";
  amount_ckb: number;
  asset: string;
  invoice_id: string | null;
  payment_hash: string | null;
  invoice: Invoice | null;
}

export const POLICY = Object.freeze({
  issuer: "urn:fibergate:paid-content",
  audience: "fibergate-paid-content",
  resource: "field-guide-v1",
  id: "three-download-requests-30-days-v1",
  uses: 3,
  lifetime: 30 * 86400,
  amount: 1,
});
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
function fail(status: number, message: string, details?: unknown): never {
  throw new HttpError(status, message, details);
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-f]{64}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createMerchant(pool: Pool, settings: Settings) {
  const gateway = new FiberGate({
    baseUrl: settings.baseUrl,
    internalSecret: settings.internalSecret,
  });
  const signer = await createAccessReceiptSigner({
    privateKey: settings.privateKey,
  });
  const verifier = await createAccessReceiptVerifier({
    publicKeys: [settings.publicKey],
    issuer: POLICY.issuer,
    audience: POLICY.audience,
  });
  const store = createPostgresAccessReceiptStore((sql, parameters) =>
    pool.query(sql, [...parameters]),
  );

  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client
        .query("ROLLBACK")
        .catch(() =>
          console.error("Rollback failed; transaction outcome requires review"),
        );
      throw error;
    } finally {
      client.release();
    }
  }

  async function authenticate(authorization = "") {
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization))
      fail(401, "Authentication required");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM merchant_accounts WHERE session_hash=$1 AND session_expires_at > now()",
      [digest(authorization.slice(7))],
    );
    if (!rows[0]) fail(401, "Invalid or expired session");
    return rows[0].id;
  }
  async function ownedOrder(subject: string, id: string) {
    const { rows } = await pool.query<OrderRow>(
      "SELECT * FROM merchant_orders WHERE id=$1 AND purchaser=$2",
      [id, subject],
    );
    if (!rows[0]) fail(404, "Order not found");
    return rows[0];
  }
  function orderView(order: OrderRow) {
    // Never expose a checkout response until its binding has committed.
    return {
      id: order.id,
      status: order.status,
      invoice: order.invoice ?? null,
      policy: POLICY,
    };
  }
  async function createOrder(subject: string, requestKey: unknown) {
    if (
      typeof requestKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(requestKey)
    )
      fail(
        400,
        "Idempotency-Key must contain 8–80 letters, digits, underscores or hyphens",
      );
    const id = randomUUID();
    const { rows } = await pool.query<OrderRow>(
      `INSERT INTO merchant_orders
      (id,purchaser,request_key,status,amount_ckb,asset) VALUES ($1,$2,$3,'creating',$4,'CKB')
      ON CONFLICT (purchaser,request_key) DO NOTHING RETURNING *`,
      [id, subject, requestKey, POLICY.amount],
    );
    if (!rows[0]) {
      const existing = (
        await pool.query<OrderRow>(
          "SELECT * FROM merchant_orders WHERE purchaser=$1 AND request_key=$2",
          [subject, requestKey],
        )
      ).rows[0];
      if (["creating", "creation_unknown"].includes(existing.status)) {
        fail(
          409,
          "Invoice creation unresolved; do not retry with a new key. H01/#93 requires operator review.",
          { orderId: existing.id },
        );
      }
      return orderView(existing);
    }
    // The committed creating row prevents concurrent POSTs/restarts from making
    // another invoice. A crash at ANY point before durable binding stays unresolved.
    try {
      const invoice = await gateway.invoices.create({
        amount: POLICY.amount,
        asset: "CKB",
        description: "Field Guide: three downloads within 30 days",
        expires_in: 3600,
        metadata: { order_id: id, example: "paid-content" },
      });
      if (
        !invoice ||
        !uuid(invoice.id) ||
        !hash(invoice.payment_hash) ||
        invoice.amount !== POLICY.amount ||
        invoice.asset !== "CKB" ||
        !["pending", "paid"].includes(invoice.status) ||
        typeof invoice.invoice_address !== "string" ||
        !invoice.invoice_address ||
        !timestamp(invoice.expires_at) ||
        !timestamp(invoice.created_at)
      ) {
        throw new Error("Unexpected invoice response; binding unsafe");
      }
      const bound = await pool.query<OrderRow>(
        `UPDATE merchant_orders SET status='awaiting_payment',
        invoice_id=$2,payment_hash=$3,invoice=$4 WHERE id=$1 AND status='creating' RETURNING *`,
        [id, invoice.id, invoice.payment_hash, invoice],
      );
      if (!bound.rows[0]) throw new Error("Binding not persisted");
      return orderView(bound.rows[0]);
    } catch {
      // Even an API error can conceal an invoice created at the Fiber node.
      // No retries, metadata recovery, or automatic creation of replacement orders.
      await pool
        .query(
          `UPDATE merchant_orders SET status='creation_unknown' WHERE id=$1 AND status='creating'`,
          [id],
        )
        .catch(() =>
          console.error(
            "Could not mark unresolved creation; durable creating row still blocks retry",
          ),
        );
      fail(
        409,
        "Invoice creation unresolved; stop and review H01/#93. No automatic retry.",
        { orderId: id },
      );
    }
  }

  async function paidWebhook(raw: string, signature: unknown) {
    if (
      typeof signature !== "string" ||
      !verifyWebhookSignature(raw, signature, settings.webhookSecret)
    )
      fail(401, "Invalid webhook signature");
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      fail(400, "Invalid JSON");
    }
    if (!isRecord(event) || typeof event.event !== "string")
      fail(400, "Invalid event");
    if (event.event !== "payment.paid") return { ignored: true };
    const d = event.data;
    // Source: FiberGate canary 9fcc793, apps/web/lib/webhooks/trigger.ts.
    // No event ID is emitted. Deduplicate fulfillment by bound purchase, not body.
    if (
      !timestamp(event.created_at) ||
      !isRecord(d) ||
      !uuid(d.invoice_id) ||
      !hash(d.payment_hash) ||
      typeof d.amount !== "number" ||
      !Number.isFinite(d.amount) ||
      typeof d.asset !== "string" ||
      !timestamp(d.paid_at) ||
      !Object.hasOwn(d, "metadata")
    )
      fail(400, "Invalid payment.paid schema");
    return transaction(async (client) => {
      const order = (
        await client.query<OrderRow>(
          "SELECT * FROM merchant_orders WHERE invoice_id=$1 FOR UPDATE",
          [d.invoice_id],
        )
      ).rows[0];
      // A webhook may race the successful create response/binding. Returning a
      // retryable error is safe; metadata never supplies missing authority.
      if (!order)
        fail(
          503,
          "Invoice not durably bound; retry delivery or review unresolved creation",
        );
      if (
        order.payment_hash !== d.payment_hash ||
        order.amount_ckb !== d.amount ||
        order.asset !== d.asset
      )
        fail(422, "Payment does not match persisted invoice binding");
      if (order.status === "paid") {
        const existing = await client.query<{ jti: string }>(
          "SELECT jti FROM access_receipts WHERE intent_id=$1",
          [order.id],
        );
        if (!existing.rows[0])
          throw new Error("Paid order missing entitlement");
        return { accepted: true, duplicate: true };
      }
      if (order.status !== "awaiting_payment") fail(503, "Order not ready");
      const now = Math.floor(Date.now() / 1000);
      const claims = buildAccessReceiptClaims({
        iss: POLICY.issuer,
        sub: order.purchaser,
        aud: POLICY.audience,
        intent_id: order.id,
        resource_id: POLICY.resource,
        policy_id: POLICY.id,
        payment_ref: order.payment_hash,
        jti: randomUUID(),
        iat: now,
        nbf: now,
        exp: now + POLICY.lifetime,
        grant_type: "multi_redemption",
        max_redemptions: POLICY.uses,
      });
      const token = await signer(claims);
      await client.query(
        `INSERT INTO accepted_payments (order_id,invoice_id,raw_body,body_sha256) VALUES ($1,$2,$3,$4)`,
        [order.id, d.invoice_id, raw, digest(raw)],
      );
      await client.query(
        `INSERT INTO access_receipts
        (jti,iss,sub,aud,intent_id,resource_id,policy_id,grant_type,max_redemptions,iat,nbf,exp,payment_ref,token)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          claims.jti,
          claims.iss,
          claims.sub,
          claims.aud,
          claims.intent_id,
          claims.resource_id,
          claims.policy_id,
          claims.grant_type,
          claims.max_redemptions,
          claims.iat,
          claims.nbf,
          claims.exp,
          claims.payment_ref,
          token,
        ],
      );
      await client.query(
        "UPDATE merchant_orders SET status='paid' WHERE id=$1",
        [order.id],
      );
      return { accepted: true, duplicate: false };
    });
  }
  async function receipt(subject: string, orderId: string) {
    const order = await ownedOrder(subject, orderId);
    if (order.status !== "paid") fail(409, "Payment not confirmed");
    const row = (
      await pool.query<{
        token: string;
        redemption_count: string;
        exp: string;
      }>(
        "SELECT token,redemption_count,exp FROM access_receipts WHERE intent_id=$1 AND sub=$2",
        [orderId, subject],
      )
    ).rows[0];
    if (!row) throw new Error("Missing entitlement");
    return {
      receipt: row.token,
      remaining: POLICY.uses - Number(row.redemption_count),
      expiresAt: Number(row.exp),
      policy: POLICY,
    };
  }
  async function download(subject: string, orderId: string, token: unknown) {
    const order = await ownedOrder(subject, orderId);
    if (order.status !== "paid") fail(403, "Payment not confirmed");
    if (typeof token !== "string" || token.length > 8192)
      fail(403, "Receipt required");
    // Read before consumption. There is no static/public file handler.
    const bytes = await readFile(
      new URL("private-assets/field-guide.txt", root),
    );
    const result = await redeemAccessReceipt({
      token,
      verifier,
      store,
      expected: {
        sub: subject,
        intent_id: order.id,
        resource_id: POLICY.resource,
        policy_id: POLICY.id,
        max_redemptions: POLICY.uses,
      },
      current_time: Math.floor(Date.now() / 1000),
    });
    if (result.status === "system_failure")
      fail(503, "Access outcome uncertain; do not automatically retry");
    if (result.status !== "success") fail(403, "Receipt denied", result);
    return { bytes, exhausted: result.exhausted };
  }
  return {
    authenticate,
    createOrder,
    paidWebhook,
    receipt,
    download,
    getOrder: async (s: string, id: string) =>
      orderView(await ownedOrder(s, id)),
  };
}
