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
  buildAlertKeyboard,
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

function diff(id: string, symbol: string, side: "buy" | "sell", amountTokens = 1): TraderAlertDiff {
  return { token: token(id, symbol), side, amountTokens };
}

type Btn = { text: string; callback_data: string };

function rowsOf(kb: ReturnType<typeof buildAlertKeyboard>): Btn[][] {
  return (kb as any).inline_keyboard as Btn[][];
}

test("keyboard: one Buy row per bought token, Ignore on its own last row", () => {
  const rows = rowsOf(
    buildAlertKeyboard("abc123", [
      { id: "banana.ft-fin.testnet", symbol: "BANANA" },
      { id: "berry.testnet", symbol: "BERRY" },
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

test("keyboard: buy rows cap at three tokens", () => {
  const tokens = ["A", "B", "C", "D", "E"].map((s) => ({ id: `${s.toLowerCase()}.testnet`, symbol: s }));
  const rows = rowsOf(buildAlertKeyboard("cap0000001", tokens));
  assert.equal(rows.length, 4); // 3 buy rows + the Ignore row
  assert.equal(rows[2][0].text, "Buy C");
  assert.equal(rows[3][0].callback_data, "alertign:cap0000001");
});

test("keyboard: a sells only alert gets the Ignore button alone", () => {
  const bought = alertBoughtTokens([diff("old.testnet", "OLD", "sell", 40)], WNEAR);
  assert.deepEqual(bought, []);
  const rows = rowsOf(buildAlertKeyboard("sells00001", bought));
  assert.deepEqual(rows, [[{ text: "Ignore", callback_data: "alertign:sells00001" }]]);
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
