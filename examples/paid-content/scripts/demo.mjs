import { readFile } from "node:fs/promises";
import { root, config } from "../dist/config.js";
if ((await config()).mode !== "fixture")
  throw new Error("Demo refuses gateway mode");
const accounts = JSON.parse(
  await readFile(new URL(".local/accounts.json", root), "utf8"),
);
const base = "http://127.0.0.1:3401";
const call = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accounts.alice}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
};
const order = await call("/orders", {
  method: "POST",
  headers: { "Idempotency-Key": `demo-${Date.now()}` },
});
console.log("Fixture order", order.id, order.status);
// Explicit fixture-only endpoint is on the separate simulator, never merchant.
const payment = await fetch(
  `http://127.0.0.1:3402/__fixture/pay/${order.invoice.id}`,
  { method: "POST" },
);
if (!payment.ok) throw new Error("Fixture delivery failed");
console.log("CONTROLLED SIGNED FIXTURE accepted; no real settlement occurred.");
const { receipt } = await call(`/orders/${order.id}/receipt`);
for (let attempt = 1; attempt <= 4; attempt++) {
  const response = await fetch(`${base}/orders/${order.id}/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accounts.alice}`,
      "X-Access-Receipt": receipt,
    },
  });
  const text = await response.text();
  console.log(
    `Download ${attempt}: HTTP ${response.status}${response.ok ? `; ${Buffer.byteLength(text)} bytes; protected guide returned` : "; allowance exhausted"}`,
  );
}
