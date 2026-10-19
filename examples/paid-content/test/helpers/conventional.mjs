// Testable conventional alternative, never imported by the merchant runtime.
export async function conventionalConsume(client, { orderId, subject }) {
  const { rows } = await client.query(
    `UPDATE conventional_grants SET used=used+1
    WHERE order_id=$1 AND purchaser=$2 AND resource='field-guide-v1'
      AND policy='three-download-requests-30-days-v1' AND paid
      AND revoked_at IS NULL AND expires_at > clock_timestamp() AND used < allowance
    RETURNING used, used=allowance AS exhausted`,
    [orderId, subject],
  );
  return rows[0] ?? null;
}
