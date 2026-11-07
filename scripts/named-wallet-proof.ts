import { KeyPair } from "near-api-js";
import { config } from "../src/config";
import { decryptPrivateKey, encryptPrivateKey } from "../src/crypto";
import { store, type UserRecord } from "../src/store";
import {
  attemptNameForNewUser,
  createNamedAccountFor,
  fullNameId,
  getCreatorWallet,
  namesEnabled,
  sanitizeLabel,
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
 * A. A brand new user whose name is derived from a sample Telegram
 *    style username: the named account is created with the same key,
 *    becomes primary on the store record, and signs a transfer out.
 * B. A funded user: NEAR and wNEAR sitting on the hex wallet are swept
 *    to the named account when the name is created.
 *
 * Every transaction hash is printed so the whole run is auditable.
 */

function assert(cond: unknown, what: string): void {
  if (!cond) throw new Error(`proof assertion failed: ${what}`);
  console.log(`  ok: ${what}`);
}

function fakeUser(telegramId: number, username: string): { user: UserRecord; secret: string; hexId: string } {
  const wallet = createWallet();
  const user: UserRecord = {
    telegramId,
    username,
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

  // ---- Part A: brand new user, name derived from the username --------
  console.log("\nPart A: fresh user, name from Telegram style username");
  const a = fakeUser(990001, `Velocity_Proof_${runTag}`);
  const candidateA = sanitizeLabel(a.user.username)!;
  const namedA = fullNameId(candidateA);
  console.log(`  username ${a.user.username} -> label ${candidateA} -> ${namedA}`);
  const resultA = await attemptNameForNewUser(a.user);
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
  const b = fakeUser(990002, `Sweep_Proof_${runTag}`);
  const labelB = sanitizeLabel(b.user.username)!;
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
  assert(namedNearAfter > 0.04, "the NEAR arrived on the named account (deposit plus sweep)");
  assert(hexNearAfter <= 0.0035, "only the small gas reserve is left on the hex wallet");

  console.log("\nNamed wallet proof complete: both parts passed on testnet.");
}

main().catch((err) => {
  console.error("named-proof failed:", err?.message ?? err);
  process.exit(1);
});
