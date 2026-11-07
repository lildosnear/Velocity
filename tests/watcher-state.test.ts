import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __resetWatcherState, watchTick, type WatchTickDeps, type WalletTradeEvent } from "../src/watcher";
import { store, type TradedToken, type WatchedWallet } from "../src/store";

/**
 * Watcher progress persistence and tick isolation. Ticks are driven
 * through WatchTickDeps with canned balances, so no chain is needed;
 * the store is the real one (temp DATA_DIR), which is the point:
 * progress must survive the in memory state being dropped, exactly
 * what a process restart does.
 */

const BANANA: TradedToken = { id: "banana.ft-fin.testnet", symbol: "BANANA", decimals: 6 };
const raw = (tokens: number) => BigInt(Math.round(tokens * 10 ** BANANA.decimals));

interface Harness {
  deps: WatchTickDeps;
  alerts: { telegramId: number; text: string }[];
  copies: WalletTradeEvent[];
  balances: Map<string, Map<string, bigint>>;
}

function makeHarness(failAccounts: Set<string> = new Set()): Harness {
  const alerts: Harness["alerts"] = [];
  const copies: WalletTradeEvent[] = [];
  const balances = new Map<string, Map<string, bigint>>();
  const deps: WatchTickDeps = {
    tokenSet: async () => [BANANA],
    scanBalances: async (accountId) => {
      if (failAccounts.has(accountId)) throw new Error(`scan blew up for ${accountId}`);
      return new Map(balances.get(accountId) ?? []);
    },
    notifyAlertFn: async (telegramId, text) => {
      alerts.push({ telegramId, text });
      return { chatId: 1, messageId: alerts.length };
    },
    notifyFn: async () => {},
    onBuy: async (event) => {
      copies.push(event);
    },
    onSell: async (event) => {
      copies.push(event);
    },
    blockHeight: async () => 12345,
  };
  return { deps, alerts, copies, balances };
}

function watch(id: string, owner: number, accountId: string, mode: "notify" | "auto"): WatchedWallet {
  const w: WatchedWallet = {
    id,
    ownerTelegramId: owner,
    accountId,
    mode,
    createdAt: new Date().toISOString(),
  };
  store.watch(w);
  return w;
}

function setBalance(h: Harness, accountId: string, tokens: number) {
  h.balances.set(accountId, new Map([[BANANA.id, raw(tokens)]]));
}

test("a restart does not re-alert a move the previous run already handled", async () => {
  const h = makeHarness();
  watch("ws-restart:trader-one.testnet", 9101, "trader-one.testnet", "notify");
  setBalance(h, "trader-one.testnet", 100);

  await watchTick(h.deps); // baseline
  assert.equal(h.alerts.length, 0, "baseline never alerts");

  // The baseline was persisted with its block height.
  const progress = store.getWatchProgress("ws-restart:trader-one.testnet");
  assert.equal(progress?.balances[BANANA.id], raw(100).toString());
  assert.equal(progress?.blockHeight, 12345);

  setBalance(h, "trader-one.testnet", 150);
  await watchTick(h.deps);
  assert.equal(h.alerts.length, 1, "the move alerts once");

  __resetWatcherState(); // simulate a process restart
  await watchTick(h.deps);
  assert.equal(h.alerts.length, 1, "no re-alert after the restart: progress came from the store");

  setBalance(h, "trader-one.testnet", 200);
  await watchTick(h.deps);
  assert.equal(h.alerts.length, 2, "diffing resumed: a move made after the restart still alerts");
});

test("a restart does not re-copy a trade the previous run already copied", async () => {
  const h = makeHarness();
  watch("ws-copy:trader-two.testnet", 9102, "trader-two.testnet", "auto");
  setBalance(h, "trader-two.testnet", 50);

  await watchTick(h.deps); // baseline
  setBalance(h, "trader-two.testnet", 80);
  await watchTick(h.deps);
  assert.equal(h.copies.length, 1, "the buy was copied once");
  assert.equal(h.copies[0].side, "buy");

  __resetWatcherState();
  await watchTick(h.deps);
  assert.equal(h.copies.length, 1, "no duplicate copy after the restart");
});

test("one account blowing up does not stop the other accounts in the same tick", async () => {
  const h = makeHarness(new Set(["bad.testnet"]));
  watch("ws-bad:bad.testnet", 9103, "bad.testnet", "notify");
  watch("ws-good:good.testnet", 9104, "good.testnet", "notify");
  setBalance(h, "good.testnet", 10);

  await watchTick(h.deps); // good baselines; bad throws and is skipped
  setBalance(h, "good.testnet", 25);
  await watchTick(h.deps);

  const goodAlerts = h.alerts.filter((a) => a.telegramId === 9104);
  assert.equal(goodAlerts.length, 1, "the healthy account still alerted in the same tick as the failure");
  assert.equal(h.alerts.filter((a) => a.telegramId === 9103).length, 0);
});
