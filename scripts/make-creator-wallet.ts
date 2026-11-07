import { createHash } from "node:crypto";
import { config } from "../src/config";
import { encryptPrivateKey } from "../src/crypto";
import { accountExists, createWallet } from "../src/near";

/**
 * Create the named wallet creator account. Run: npm run make-creator-wallet
 *
 * The creator is the funded account that signs create_account calls on
 * the network registrar ("testnet" here, "near" on mainnet) whenever a
 * user gets a named wallet (see src/names.ts). Each creation costs the
 * creator the NAME_CREATION_DEPOSIT_NEAR starter deposit (default
 * 0.01 NEAR, which lands in the user's new account as its balance)
 * plus a little gas, so the creator only ever needs a modest balance;
 * top it up when it runs low.
 *
 * Two shapes are supported:
 * 1. Implicit wallet (default): prints a fresh implicit account id and
 *    the encrypted secret, ready to paste into .env as CREATOR_ACCOUNT_ID
 *    and CREATOR_SECRET_ENC. Fund it by sending NEAR to the account id.
 *    On testnet get free NEAR at https://faucet.fastnear.com. Note the
 *    faucet pays out to named testnet accounts most reliably; if it
 *    will not fund an implicit id, use shape 2.
 * 2. Named account: create the named account yourself first in a
 *    testnet wallet (https://wallet.testnet.near.org) or with near-cli,
 *    export its secret key, then encrypt it with:
 *      npm run smoke -- --encrypt-key "ed25519:..."
 *    and paste CREATOR_ACCOUNT_ID=<the account id> and the printed JSON
 *    as CREATOR_SECRET_ENC into .env.
 *
 * With no creator configured, named wallets stay dormant and every
 * user keeps the implicit hex wallet, exactly as before.
 */
async function main() {
  void config; // loading config validates MASTER_KEY first, like Forge
  const wallet = createWallet();
  const enc = encryptPrivateKey(wallet.secret);
  const fingerprint = createHash("sha256").update(wallet.publicKey).digest("hex").slice(0, 8);
  console.log("New implicit creator wallet created locally (key fingerprint " + fingerprint + ").");
  console.log("Paste into .env:");
  console.log(`CREATOR_ACCOUNT_ID=${wallet.accountId}`);
  console.log(`CREATOR_SECRET_ENC=${JSON.stringify(enc)}`);
  console.log("");
  console.log("Then fund it: send some NEAR to the account id above. Each named wallet");
  console.log("creation spends the NAME_CREATION_DEPOSIT_NEAR starter deposit (default");
  console.log("0.01 NEAR, it lands in the user's new account) plus a little gas.");
  console.log("On testnet: https://faucet.fastnear.com (named accounts fund most reliably,");
  console.log("for a named creator account see the notes at the top of this script).");
  console.log("Exists on chain already:", await accountExists(wallet.accountId));
  console.log("");
  console.log("The secret key itself was only printed in encrypted form. The plain key");
  console.log("existed only in this process memory and is gone when it exits.");
}

main().catch((err) => {
  console.error("make-creator-wallet failed:", err?.message ?? err);
  process.exit(1);
});
