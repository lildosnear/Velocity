import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pendingAlertExpired,
  prunePendingAlerts,
  store,
  type PendingAlert,
} from "../src/store";
import {
  alertBoughtTokens,
  alertBuyAmountNear,
  alertLegs,
  alertSellAmountRaw,
  buildAlertKeyboard,
  sellFractionOf,
  type TraderAlertDiff,
} from "../src/watcher";
import { config } from "../src/config";
import type { TradedToken } from "../src/store";

const WNEAR = "wrap.testnet";
const HOUR = 60 * 60 * 1000;

function makeAlert(id: string, createdAtMs: number): PendingAlert {
  return {
    id,
    telegramId: 42,
    traderAccountId: "oxdevv.testnet",
    tokens: [{ id: "banana.ft-fin.testnet", symbol: "BANANA" }],
    legs: [{ side: "buy", id: "banana.ft-fin.testnet", symbol: "BANANA" }],
    text: "Trader alert: oxdevv.testnet bought 2,889.42 BANANA.",
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

test("pending alert store round trip: save, read back, delete", () => {
  const alert = makeAlert("roundtrip1", Date.now());
  store.savePendingAlert(alert);
  const back = store.getPendingAlert("roundtrip1");
  assert.deepEqual(back, alert);
  store.deletePendingAlert("roundtrip1");
  assert.equal(store.getPendingAlert("roundtrip1"), undefined);
});

test("pending alerts expire at one hour and writes prune the expired", () => {
  const now = Date.now();
  const stale = makeAlert("stale00001", now - 2 * HOUR);
  assert.equal(pendingAlertExpired(stale, now), true);
  assert.equal(pendingAlertExpired(makeAlert("fresh00001", now), now), false);

  store.savePendingAlert(stale);
  // Saving another alert prunes everything past the TTL, stale included.
  store.savePendingAlert(makeAlert("fresh00002", now));
  assert.equal(store.getPendingAlert("stale00001"), undefined);
  assert.ok(store.getPendingAlert("fresh00002"));
  store.deletePendingAlert("fresh00002");
});

test("prunePendingAlerts keeps fresh records and drops expired ones", () => {
  const now = Date.now();
  const pruned = prunePendingAlerts(
    { old: makeAlert("old", now - HOUR - 1), fresh: makeAlert("fresh", now) },
    now,
  );
  assert.deepEqual(Object.keys(pruned), ["fresh"]);
});

function token(id: string, symbol: string): TradedToken {
  return { id, symbol, decimals: 24 };
}

function diff(
  id: string,
  symbol: string,
  side: "buy" | "sell",
  amountTokens = 1,
  beforeTokens?: number,
): TraderAlertDiff {
  return { token: token(id, symbol), side, amountTokens, beforeTokens };
}

type Btn = { text: string; callback_data: string };

function rowsOf(kb: ReturnType<typeof buildAlertKeyboard>): Btn[][] {
  return (kb as any).inline_keyboard as Btn[][];
}

test("keyboard: one Buy row per bought token, Ignore on its own last row", () => {
  const rows = rowsOf(
    buildAlertKeyboard("abc123", [
      { side: "buy", id: "banana.ft-fin.testnet", symbol: "BANANA" },
      { side: "buy", id: "berry.testnet", symbol: "BERRY" },
    ]),
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], [{ text: "Buy BANANA", callback_data: "alertbuy:abc123:0" }]);
  assert.deepEqual(rows[1], [{ text: "Buy BERRY", callback_data: "alertbuy:abc123:1" }]);
  assert.deepEqual(rows[2], [{ text: "Ignore", callback_data: "alertign:abc123" }]);
  for (const row of rows) {
    for (const b of row) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64);
  }
});

test("keyboard: action rows cap at three legs", () => {
  const legs = ["A", "B", "C", "D", "E"].map((s) => ({
    side: "buy" as const,
    id: `${s.toLowerCase()}.testnet`,
    symbol: s,
  }));
  const rows = rowsOf(buildAlertKeyboard("cap0000001", legs));
  assert.equal(rows.length, 4); // 3 action rows + the Ignore row
  assert.equal(rows[2][0].text, "Buy C");
  assert.equal(rows[3][0].callback_data, "alertign:cap0000001");
});

test("keyboard: a sells only alert gets its Sell rows plus Ignore", () => {
  const legs = alertLegs([diff("old.testnet", "OLD", "sell", 40, 100)], WNEAR);
  assert.deepEqual(alertBoughtTokens([diff("old.testnet", "OLD", "sell", 40)], WNEAR), []);
  const rows = rowsOf(buildAlertKeyboard("sells00001", legs));
  assert.deepEqual(rows, [
    [{ text: "Sell OLD", callback_data: "alertsell:sells00001:0" }],
    [{ text: "Ignore", callback_data: "alertign:sells00001" }],
  ]);
  for (const row of rows) {
    for (const b of row) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64);
  }
});

test("keyboard: mixed buy and sell legs keep alert order, sells first", () => {
  const legs = alertLegs(
    [
      diff("banana.ft-fin.testnet", "BANANA", "buy", 100),
      diff("old.testnet", "OLD", "sell", 40, 80),
      diff("berry.testnet", "BERRY", "buy", 5),
      diff("extra.testnet", "EXTRA", "sell", 1, 4),
    ],
    WNEAR,
  );
  // Four legs exist but the action cap keeps three: sells first, then buys.
  assert.deepEqual(
    legs.map((l) => `${l.side}:${l.symbol}`),
    ["sell:OLD", "sell:EXTRA", "buy:BANANA"],
  );
  const rows = rowsOf(buildAlertKeyboard("mixed00001", legs));
  assert.deepEqual(
    rows.map((r) => r[0].callback_data),
    ["alertsell:mixed00001:0", "alertsell:mixed00001:1", "alertbuy:mixed00001:2", "alertign:mixed00001"],
  );
  assert.deepEqual(
    rows.map((r) => r[0].text),
    ["Sell OLD", "Sell EXTRA", "Buy BANANA", "Ignore"],
  );
});

test("sell legs store the fraction of the trader's holding they sold, clamped", () => {
  // Half exit: sold 50 of a 100 balance.
  assert.equal(sellFractionOf(diff("old.testnet", "OLD", "sell", 50, 100)), 0.5);
  assert.equal(alertLegs([diff("old.testnet", "OLD", "sell", 50, 100)], WNEAR)[0].sellFraction, 0.5);
  // Full exit: sold everything.
  assert.equal(alertLegs([diff("old.testnet", "OLD", "sell", 100, 100)], WNEAR)[0].sellFraction, 1);
  // Numbers that overshoot (rounding between polls) clamp to a full exit.
  assert.equal(alertLegs([diff("old.testnet", "OLD", "sell", 120, 100)], WNEAR)[0].sellFraction, 1);
  // No balance before means no fraction can be derived: full exit fallback.
  assert.equal(alertLegs([diff("old.testnet", "OLD", "sell", 40)], WNEAR)[0].sellFraction, 1);
  assert.equal(alertLegs([diff("old.testnet", "OLD", "sell", 40, 0)], WNEAR)[0].sellFraction, 1);
  // Buy legs carry no fraction.
  assert.equal(alertLegs([diff("old.testnet", "OLD", "buy", 40)], WNEAR)[0].sellFraction, undefined);
});

test("sell legs follow the wNEAR rule: rail dropped beside another token, kept alone", () => {
  const legs = alertLegs(
    [diff(WNEAR, "wNEAR", "sell", 0.1, 0.2), diff("banana.ft-fin.testnet", "BANANA", "buy", 10)],
    WNEAR,
  );
  assert.deepEqual(legs.map((l) => l.symbol), ["BANANA"]);
  const wnearOnly = alertLegs([diff(WNEAR, "wNEAR", "sell", 0.1, 0.2)], WNEAR);
  assert.equal(wnearOnly.length, 1);
  assert.equal(wnearOnly[0].side, "sell");
  assert.equal(wnearOnly[0].sellFraction, 0.5);
});

test("alert sell amount: fraction of the user's current balance, floored to raw units", () => {
  assert.equal(alertSellAmountRaw(1001n, 0.5), 500n); // 500.5 floors to 500
  assert.equal(alertSellAmountRaw(1000n, 0.25), 250n);
  assert.equal(alertSellAmountRaw(1000n, 1), 1000n); // full exit takes the exact balance
  assert.equal(alertSellAmountRaw(1000n, undefined), 1000n); // no fraction stored: full holding
  assert.equal(alertSellAmountRaw(1000n, 0), 0n);
  assert.equal(alertSellAmountRaw(0n, 0.5), 0n); // holds none: sells nothing
  assert.equal(alertSellAmountRaw(0n, undefined), 0n);
});

test("alertBoughtTokens follows the alert text: wNEAR leg dropped beside another token", () => {
  const bought = alertBoughtTokens(
    [
      diff(WNEAR, "wNEAR", "buy", 0.1),
      diff("banana.ft-fin.testnet", "BANANA", "buy", 2889.42),
      diff("old.testnet", "OLD", "sell", 5),
    ],
    WNEAR,
  );
  assert.deepEqual(bought, [{ id: "banana.ft-fin.testnet", symbol: "BANANA" }]);
  // wNEAR alone is a real event and keeps its button.
  assert.deepEqual(alertBoughtTokens([diff(WNEAR, "wNEAR", "buy", 0.1)], WNEAR), [
    { id: WNEAR, symbol: "wNEAR" },
  ]);
});

test("alert buy size: AI per trade size when set, default otherwise, cap always applied", () => {
  assert.equal(alertBuyAmountNear({}), config.alertBuyNear);
  assert.equal(alertBuyAmountNear({ ai: undefined }), 0.1);
  assert.equal(alertBuyAmountNear({ ai: { perTradeAmount: 0.5 } }), 0.5);
  assert.equal(alertBuyAmountNear({ ai: { perTradeAmount: 0 } }), config.alertBuyNear);
  assert.equal(alertBuyAmountNear({ ai: { perTradeAmount: 999 } }), config.maxTradeNear);
});
