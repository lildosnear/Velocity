import { createHash } from "node:crypto";
import { config } from "../src/config";
import { encryptPrivateKey } from "../src/crypto";
import { accountExists, createWallet } from "../src/near";

/**
 * Create the bot fee wallet, the Velocity counterpart of Forge
 * make-inventory. Run: npm run make-fee-wallet
 *
 * The fee wallet receives the bot fee on every trade and pays referral
 * bonuses out through /ref withdraw, which is why the bot needs its key.
 *
 * Two shapes are supported:
 * 1. Implicit wallet (default): prints a fresh implicit account id and
 *    the encrypted secret, ready to paste into .env as FEE_ACCOUNT_ID and
 *    FEE_ACCOUNT_SECRET_ENC. Fund it with a little NEAR (gas for referral
 *    payouts) by sending NEAR to the account id. On testnet get free NEAR
 *    at https://faucet.fastnear.com. Note the faucet pays out to named
 *    testnet accounts most reliably; if it will not fund an implicit id,
 *    use shape 2.
 * 2. Named account (recommended on testnet, velocitybot.testnet):
 *    create the named account yourself first in a testnet wallet
 *    (https://wallet.testnet.near.org) or with near-cli, export its secret
 *    key, then encrypt it with:
 *      npm run smoke -- --encrypt-key "ed25519:..."
 *    and paste FEE_ACCOUNT_ID=velocitybot.testnet and the printed JSON as
 *    FEE_ACCOUNT_SECRET_ENC into .env. This script never creates named
 *    accounts on chain, because that needs a funded parent account key
 *    that should never live next to the bot.
 */
async function main() {
  void config; // loading config validates MASTER_KEY first, like Forge
  const wallet = createWallet();
  const enc = encryptPrivateKey(wallet.secret);
  const fingerprint = createHash("sha256").update(wallet.publicKey).digest("hex").slice(0, 8);
  console.log("New implicit fee wallet created locally (key fingerprint " + fingerprint + ").");
  console.log("Paste into .env:");
  console.log(`FEE_ACCOUNT_ID=${wallet.accountId}`);
  console.log(`FEE_ACCOUNT_SECRET_ENC=${JSON.stringify(enc)}`);
  console.log("");
  console.log("Then fund it: send a little NEAR to the account id above.");
  console.log("On testnet: https://faucet.fastnear.com (named accounts fund most reliably,");
  console.log("for a named fee account such as velocitybot.testnet see the notes at the top of this script).");
  console.log("Exists on chain already:", await accountExists(wallet.accountId));
  console.log("");
  console.log("The secret key itself was only printed in encrypted form. The plain key");
  console.log("existed only in this process memory and is gone when it exits.");
}

main().catch((err) => {
  console.error("make-fee-wallet failed:", err?.message ?? err);
  process.exit(1);
});
