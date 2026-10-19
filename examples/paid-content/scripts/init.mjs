import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await mkdir(new URL(".local/", root), { recursive: true });
async function createOnce(name, value) {
  try {
    await writeFile(new URL(`.local/${name}`, root), value, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Preserve credentials and keys on rerun; never rotate an existing grant's key.
  }
}
await createOnce(
  "database.env",
  [
    "POSTGRES_USER=paid_content",
    "POSTGRES_DB=paid_content",
    `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"),
);
await createOnce(
  "accounts.json",
  JSON.stringify(
    Object.fromEntries(
      ["alice", "bob"].map((id) => [id, randomBytes(32).toString("hex")]),
    ),
    null,
    2,
  ),
);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await createOnce(
  "keys.json",
  JSON.stringify(
    {
      privateKey: {
        ...privateKey.export({ format: "jwk" }),
        kid: "paid-content-local-1",
      },
      publicKey: {
        ...publicKey.export({ format: "jwk" }),
        kid: "paid-content-local-1",
      },
      fixtureInternalSecret: randomBytes(32).toString("hex"),
      fixtureWebhookSecret: randomBytes(32).toString("hex"),
    },
    null,
    2,
  ),
);
console.log(
  "Local database credentials, sessions and signing keys initialized in ignored .local/. Existing files preserved; no credentials printed.",
);
