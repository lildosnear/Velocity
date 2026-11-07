import { KeyPair } from "near-api-js";
import { config } from "../src/config";
import { decryptPrivateKey, encryptPrivateKey } from "../src/crypto";
import { store, type UserRecord } from "../src/store";
import {
  createNamedAccountFor,
  fullNameId,
  getCreatorWallet,
  namesEnabled,
} from "../src/names";
import {
  accountExists,
  createWallet,
  readAccessKeyPermission,
  readFtBalance,
  readNearBalance,
  transferFt,
  transferNear,
  wrapNear,
  type WalletCreds,
} from "../src/near";

/**
 * Live proof for named wallets. Run: npm run named-proof
 *
 * Uses the creator account configured in .env (CREATOR_ACCOUNT_ID and
 * CREATOR_SECRET_ENC; in the build sandbox that is the funded swap
 * proof wallet). Testnet play money only. Two parts:
 *
 * A. A brand new user claims a name they typed themselves (the only
 *    way names are chosen now: the bot asks, the user answers): the
 *    named account is created with the same key, becomes primary on
 *    the store record, and signs a transfer out.
 * B. A funded user: NEAR and wNEAR sitting on the hex wallet are swept
 *    to the named account when the name is created.
 *
 * Every transaction hash is printed so the whole run is auditable.
 */

function assert(cond: unknown, what: string): void {
  if (!cond) throw new Error(`proof assertion failed: ${what}`);
  console.log(`  ok: ${what}`);
}

function fakeUser(telegramId: number): { user: UserRecord; secret: string; hexId: string } {
  const wallet = createWallet();
  const user: UserRecord = {
    telegramId,
    accountId: wallet.accountId,
    encSecret: encryptPrivateKey(wallet.secret),
    tokens: {},
    payCurrency: "NEAR",
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  return { user, secret: wallet.secret, hexId: wallet.accountId };
}

async function main() {
  if (config.network !== "testnet") throw new Error("this proof is testnet only");
  if (!namesEnabled()) {
    throw new Error("named wallets are not enabled: set CREATOR_ACCOUNT_ID and CREATOR_SECRET_ENC in .env first (npm run make-creator-wallet).");
  }
  const creator = getCreatorWallet()!;
  const creatorUser = store.allUsers().find((u) => u.accountId === creator.accountId);
  if (!creatorUser) throw new Error("the configured creator is not a store user in this sandbox, cannot sign the funding steps");
  const creatorCreds: WalletCreds = { accountId: creator.accountId, secret: decryptPrivateKey(creatorUser.encSecret) };
  console.log(`Creator: ${creator.accountId} (balance ${await readNearBalance(creator.accountId)} NEAR)`);
  console.log(`Registrar: ${config.registrarId}, suffix ${config.nameSuffix}, creation deposit ${Number(config.nameCreationDepositYocto) / 1e24} NEAR`);

  const runTag = String(Date.now() % 100000);

  // ---- Part A: brand new user, name they typed themselves ------------
  console.log("\nPart A: fresh user, typed name claimed");
  const a = fakeUser(990001);
  const labelA = `velocity-proof-${runTag}`;
  const namedA = fullNameId(labelA);
  console.log(`  typed label ${labelA} -> ${namedA}`);
  const resultA = await createNamedAccountFor(a.user, labelA);
  assert(resultA.state === "created", `creation state is created (got ${resultA.state}: ${resultA.reason ?? ""})`);
  console.log(`  create_account tx: ${resultA.txids?.[0]}`);
  const recordA = store.getUser(990001)!;
  assert(recordA.accountId === namedA, "store record primary account is the named account");
  assert(recordA.legacyAccountId === a.hexId, "store record keeps the hex wallet as legacyAccountId");
  assert(recordA.nameStatus?.state === "created", "store record nameStatus is created");
  assert(await accountExists(namedA), "named account exists on chain");
  const pubA = KeyPair.fromString(a.secret as any).getPublicKey().toString();
  const permA = await readAccessKeyPermission(namedA, pubA);
  assert(permA === "FullAccess", `named account access key is the wallet public key (permission: ${String(permA)})`);
  const outTx = await transferNear({ accountId: namedA, secret: a.secret }, creator.accountId, 5n * 10n ** 20n);
  console.log(`  signed transfer of 0.0005 NEAR out of the named account: ${outTx}`);
  assert(typeof outTx === "string" && outTx.length > 20, "the named account signed a transfer with the same key");
  console.log(`  named account balance: ${await readNearBalance(namedA)} NEAR (started at the creation deposit)`);

  // ---- Part B: funded user, sweep on creation ------------------------
  console.log("\nPart B: funded user, balances sweep to the name");
  const b = fakeUser(990002);
  const labelB = `sweep-proof-${runTag}`;
  const namedB = fullNameId(labelB);
  b.user.tokens[config.wnearId] = { id: config.wnearId, symbol: "wNEAR", decimals: 24 };
  store.saveUser(b.user);
  const fundTx = await transferNear(creatorCreds, b.hexId, 5n * 10n ** 22n);
  console.log(`  funded hex wallet with 0.05 NEAR: ${fundTx}`);
  await wrapNear(creatorCreds, 10n ** 22n);
  const ftTx = await transferFt(creatorCreds, config.wnearId, b.hexId, 10n ** 22n);
  console.log(`  sent 0.01 wNEAR to the hex wallet: ${ftTx}`);
  console.log(`  hex before: ${await readNearBalance(b.hexId)} NEAR, ${await readFtBalance(config.wnearId, b.hexId, 24)} wNEAR`);
  const resultB = await createNamedAccountFor(b.user, labelB);
  assert(resultB.state === "created", `creation state is created (got ${resultB.state}: ${resultB.reason ?? ""})`);
  console.log(`  create_account tx: ${resultB.txids?.[0]}`);
  console.log(`  sweep txs: ${(resultB.txids ?? []).slice(1).join(", ") || "none"}`);
  console.log(`  swept NEAR reported: ${resultB.sweptNear}, leftovers: ${(resultB.leftovers ?? []).join(" | ") || "none"}`);
  const recordB = store.getUser(990002)!;
  assert(recordB.accountId === namedB && recordB.legacyAccountId === b.hexId, "store record switched to the name, hex kept as legacy");
  const hexNearAfter = await readNearBalance(b.hexId);
  const namedNearAfter = await readNearBalance(namedB);
  const hexWnearAfter = await readFtBalance(config.wnearId, b.hexId, 24);
  const namedWnearAfter = await readFtBalance(config.wnearId, namedB, 24);
  console.log(`  hex after: ${hexNearAfter} NEAR, ${hexWnearAfter} wNEAR`);
  console.log(`  named after: ${namedNearAfter} NEAR, ${namedWnearAfter} wNEAR`);
  assert(namedWnearAfter === 0.01 && hexWnearAfter === 0, "all wNEAR moved to the named account");
  assert(namedNearAfter > 0.035, "the NEAR arrived on the named account (deposit plus sweep)");
  // The NEAR leg reads the legacy balance once, and that read can land
  // while the token sweep's gas refunds are still settling, so the
  // sweep may move less than balance minus reserve and leave more
  // behind. That is the designed best effort contract, not a failure:
  // whatever remains must be openly reported as a leftover (amount
  // plus old address), and the old address stays on the record.
  const leftoverReported = (resultB.leftovers ?? []).some((l) => l.includes("NEAR is still on your old address"));
  assert(
    hexNearAfter <= 0.0035 || leftoverReported,
    "the hex wallet is down to the small gas reserve, or the remainder was openly reported as a leftover",
  );

  console.log("\nNamed wallet proof complete: both parts passed on testnet.");
}

main().catch((err) => {
  console.error("named-proof failed:", err?.message ?? err);
  process.exit(1);
});
