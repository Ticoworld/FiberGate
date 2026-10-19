import http, { type IncomingMessage } from "node:http";
import type { Pool } from "pg";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createMerchant, HttpError } from "./merchant.js";
import { makePool, config, type Settings } from "./config.js";

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function serve(pool: Pool, settings: Settings, port = 3401) {
  const merchant = await createMerchant(pool, settings);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/health")
        return json(200, { ok: true });
      if (req.method === "GET" && path === "/")
        return json(200, {
          product: "Fiber Merchant Field Guide",
          price: "1 CKB",
          allowance: "Three download requests within 30 days of fulfillment",
          instructions:
            "See README.md. Local fixture payments are simulated, never real settlement.",
        });
      if (req.method === "POST" && path === "/webhook")
        return json(
          200,
          await merchant.paidWebhook(
            await body(req),
            req.headers["x-fiber-signature"],
          ),
        );
      const subject = await merchant.authenticate(req.headers.authorization);
      if (req.method === "POST" && path === "/orders")
        return json(
          201,
          await merchant.createOrder(subject, req.headers["idempotency-key"]),
        );
      const match = /^\/orders\/([\da-f-]{36})(?:\/(receipt|download))?$/.exec(
        path,
      );
      if (!match) throw new HttpError(404, "Not found");
      const [, id, action] = match;
      if (req.method === "GET" && !action)
        return json(200, await merchant.getOrder(subject, id));
      if (req.method === "GET" && action === "receipt")
        return json(200, await merchant.receipt(subject, id));
      if (req.method === "POST" && action === "download") {
        if (req.headers.range)
          throw new HttpError(416, "Partial downloads are unsupported");
        const { bytes, exhausted } = await merchant.download(
          subject,
          id,
          req.headers["x-access-receipt"],
        );
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="field-guide.txt"',
          "Content-Length": bytes.length,
          "X-Allowance-Exhausted": String(exhausted),
        });
        return res.end(bytes);
      }
      throw new HttpError(405, "Method not allowed");
    } catch (error) {
      // Do not expose tokens, keys, database details or upstream errors.
      if (error instanceof HttpError)
        return json(error.status, {
          error: error.message,
          details: error.details,
        });
      console.error(
        "Merchant operation failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      json(503, {
        error: "Operation failed; retry only when its outcome is known",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pool = await makePool();
  const server = await serve(
    pool,
    await config(),
    Number(process.env.PORT ?? 3401),
  );
  console.log(
    `Merchant listening on http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const stop = () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
