import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectStore,
  listStoreBackups,
  store,
  STORE_BACKUPS_KEPT,
  verifyStoredSecrets,
  type UserRecord,
} from "../src/store";
import { encryptPrivateKey } from "../src/crypto";
import { createWallet } from "../src/near";

/**
 * Store durability: atomic saves, rotating backups, fallback loading
 * and master key verification. The store under test lives in the
 * per process temp DATA_DIR from setup.ts; the tests below run in
 * order and build on each other's on disk state deliberately.
 */

const dataDir = process.env.DATA_DIR!;
const storePath = join(dataDir, "store.json");

function makeUser(telegramId: number): UserRecord {
  const wallet = createWallet();
  return {
    telegramId,
    accountId: wallet.accountId,
    encSecret: encryptPrivateKey(wallet.secret),
    tokens: {},
    payCurrency: "NEAR",
    createdAt: new Date().toISOString(),
  };
}

test("an atomic save leaves a complete parseable store and no temp file behind", () => {
  const user = makeUser(7001);
  store.saveUser(user);
  const parsed = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(parsed.users["7001"].accountId, user.accountId);
  const leftovers = readdirSync(dataDir).filter((f) => f.startsWith("store.json.tmp"));
  assert.deepEqual(leftovers, [], "the temp file is renamed away, never left behind");
  assert.deepEqual(store.getUser(7001)?.accountId, user.accountId);
});

test("saves keep a bounded set of rotating backups", () => {
  for (let i = 0; i < 8; i++) {
    const user = makeUser(7001);
    user.payCurrency = i % 2 === 0 ? "NEAR" : "USDC";
    store.saveUser(user);
  }
  const backups = listStoreBackups();
  assert.ok(backups.length >= 1, "backups are being written");
  assert.ok(backups.length <= STORE_BACKUPS_KEPT, `at most ${STORE_BACKUPS_KEPT} backups are kept, saw ${backups.length}`);
  for (const b of backups) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(b, "utf8")), "every kept backup parses");
  }
  const inspection = inspectStore();
  assert.equal(inspection.exists, true);
  assert.equal(inspection.parses, true);
  assert.ok(inspection.userCount >= 1);
  assert.equal(inspection.backupCount, backups.length);
});

test("master key verification passes for wallets encrypted under the configured key", () => {
  const result = verifyStoredSecrets();
  assert.equal(result.ok, true);
  assert.ok(result.userCount >= 1);
});

test("master key verification fails when a stored secret no longer decrypts", () => {
  const parsed = JSON.parse(readFileSync(storePath, "utf8"));
  const first = Object.values<any>(parsed.users)[0];
  // Same JSON shape, corrupted ciphertext: the GCM tag check must fail.
  first.encSecret = { iv: first.encSecret.iv, tag: first.encSecret.tag, data: "00".repeat(48) };
  writeFileSync(storePath, JSON.stringify(parsed, null, 2), "utf8");
  const result = verifyStoredSecrets();
  assert.equal(result.ok, false);
  assert.ok(result.userCount >= 1);
});

test("a corrupt main store falls back to the newest readable backup", () => {
  // Repair the main store first (the tamper test above broke one
  // secret in it; the fallback below must start from a clean save).
  const clean = makeUser(7002);
  store.saveUser(clean);
  const beforeIds = store.allUsers().map((u) => u.telegramId).sort();
  const marker = makeUser(7003);
  store.saveUser(marker); // this save backs up the pre marker state
  assert.ok(store.getUser(7003), "marker user is in the main store");

  writeFileSync(storePath, "{ this is not json", "utf8");
  const after = store.allUsers().map((u) => u.telegramId).sort();
  assert.deepEqual(after, beforeIds, "state rolled back to the backup: marker gone, everyone else intact");
});

test("a missing main store also falls back to the backup", () => {
  unlinkSync(storePath);
  assert.equal(existsSync(storePath), false);
  const users = store.allUsers();
  assert.ok(users.length >= 1, "users are still visible from the backup");
  assert.equal(store.getUser(7003), undefined, "the marker user only ever existed in the lost main store");
});

test("when nothing readable remains, loading refuses instead of starting empty", () => {
  writeFileSync(storePath, "garbage", "utf8");
  for (const backup of listStoreBackups()) writeFileSync(backup, "garbage", "utf8");
  assert.throws(() => store.allUsers(), /could not be loaded/);
  const inspection = inspectStore();
  assert.equal(inspection.parses, false);
  assert.equal(inspection.userCount, 0);
});
