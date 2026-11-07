import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { config } from "./config";

/**
 * Key handling, ported from Forge with the same storage format.
 * - Hot wallet secret keys are AES 256 GCM encrypted at rest with MASTER_KEY.
 * - Decrypted only in memory, at signing time. Never logged, never written
 *   to disk in plain form.
 * - Security note: custody is per user hot wallets, the Forge pattern,
 *   and the master key lives on the same box as the bot. Keep trade caps
 *   small and treat the server as the trust boundary it is.
 */

const masterKey = Buffer.from(config.masterKeyHex, "hex");

export interface EncryptedKey {
  iv: string;
  tag: string;
  data: string;
}

/** Encrypt a NEAR secret key string ("ed25519:...") for storage. */
export function encryptPrivateKey(secretUtf8: string): EncryptedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const data = Buffer.concat([cipher.update(secretUtf8, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") };
}

export function decryptPrivateKey(enc: EncryptedKey): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(enc.iv, "hex"));
  decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, "hex")), decipher.final()]).toString("utf8");
}
