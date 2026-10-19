// LOCAL CONTROLLED FIXTURE ONLY. No Fiber node, RPC, channel or settlement.
import http from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { config } from "../dist/config.js";

export const signFixture = (raw, secret) =>
  `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
export function paidFixture(invoice, overrides = {}) {
  return {
    event: "payment.paid",
    created_at: new Date().toISOString(),
    data: {
      invoice_id: invoice.id,
      payment_hash: invoice.payment_hash,
      amount: invoice.amount,
      asset: invoice.asset,
      paid_at: new Date().toISOString(),
      metadata: invoice.metadata ?? null,
      ...overrides,
    },
  };
}
export async function fixtureGateway(settings, port = 3402) {
  const invoices = new Map();
  const control = { creates: 0, nextFailure: null, beforeResponse: null };
  const server = http.createServer(async (req, res) => {
    const json = (status, data, error = null) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data, error }));
    };
    try {
      if (req.method === "POST" && req.url?.startsWith("/__fixture/pay/")) {
        const invoice = invoices.get(req.url.split("/").at(-1));
        if (!invoice)
          return json(404, null, {
            code: "NOT_FOUND",
            message: "Fixture invoice missing",
          });
        const raw = JSON.stringify(paidFixture(invoice));
        const response = await fetch(
          `${process.env.MERCHANT_URL ?? "http://127.0.0.1:3401"}/webhook`,
          {
            method: "POST",
            headers: {
              "X-Fiber-Signature": signFixture(raw, settings.webhookSecret),
            },
            body: raw,
          },
        );
        return json(response.status, {
          fixtureOnly: true,
          merchant: await response.json(),
        });
      }
      if (req.headers.authorization !== `Bearer ${settings.internalSecret}`)
        return json(401, null, {
          code: "UNAUTHORIZED",
          message: "Fixture authorization required",
        });
      if (req.method === "POST" && req.url === "/api/v1/invoices") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        control.creates++;
        const invoice = {
          id: randomUUID(),
          invoice_address: `FIXTURE_ONLY_NOT_PAYABLE_${randomUUID()}`,
          payment_hash: `0x${randomBytes(32).toString("hex")}`,
          amount: input.amount,
          asset: input.asset,
          status: "pending",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          created_at: new Date().toISOString(),
        };
        invoices.set(invoice.id, { ...invoice, metadata: input.metadata });
        if (control.beforeResponse)
          await control.beforeResponse(invoices.get(invoice.id));
        const failure = control.nextFailure;
        control.nextFailure = null;
        if (failure === "disconnect") return req.socket.destroy();
        if (failure === "malformed")
          return json(201, { ...invoice, payment_hash: "bad" });
        if (failure === "api-error")
          return json(500, null, {
            code: "INTERNAL_ERROR",
            message: "Ambiguous fixture error after creation",
          });
        return json(201, invoice);
      }
      const invoice = invoices.get(req.url?.split("/").at(-1));
      if (req.method === "GET" && invoice)
        return json(200, { ...invoice, paid_at: null });
      return json(404, null, {
        code: "NOT_FOUND",
        message: "Fixture route missing",
      });
    } catch {
      return json(500, null, {
        code: "FIXTURE_ERROR",
        message: "Fixture failed",
      });
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    invoices,
    control,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const settings = await config();
  if (settings.mode !== "fixture")
    throw new Error("Simulator refuses gateway mode");
  const fixture = await fixtureGateway(settings);
  console.log(
    `CONTROLLED FIXTURE on 127.0.0.1:${fixture.server.address().port}; invoices are NOT PAYABLE; paid events simulate settlement.`,
  );
}
