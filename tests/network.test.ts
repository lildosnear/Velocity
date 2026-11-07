import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { config, loadConfig, parseTradingEnabled } from "../src/config";
import { networkCaptionName, networkPill, pnlCaption } from "../src/share/pnl";
import { assertTradingEnabled, executeBuy, executeSell } from "../src/market";
import type { UserRecord } from "../src/store";

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "test-token",
  MASTER_KEY: "22".repeat(32),
};

test("mainnet config selects the verified mainnet contract set", () => {
  const c = loadConfig({ ...BASE_ENV, NEAR_NETWORK: "mainnet" });
  assert.equal(c.network, "mainnet");
  assert.equal(c.refExchangeId, "v2.ref-finance.near");
  assert.equal(c.dclExchangeId, "dclv2.ref-labs.near");
  assert.equal(c.wnearId, "wrap.near");
  assert.equal(c.registrarId, "near");
  assert.equal(c.nameSuffix, ".near");
  const usdc = c.payCurrencies.find((p) => p.id === "USDC");
  const usdt = c.payCurrencies.find((p) => p.id === "USDT");
  assert.equal(usdc?.contractId, "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near");
  assert.equal(usdt?.contractId, "usdt.tether-token.near");
  assert.deepEqual(c.nearRpcUrls, [
    "https://rpc.mainnet.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.mainnet.near.org",
  ]);
  // No mainnet value may point at a testnet id.
  const ids = [c.refExchangeId, c.dclExchangeId, c.wnearId, c.registrarId, usdc?.contractId ?? "", usdt?.contractId ?? ""];
  for (const id of ids) assert.ok(!id.endsWith(".testnet"), `${id} must not be a testnet id`);
});

test("testnet config keeps the proven testnet contract set", () => {
  const c = loadConfig({ ...BASE_ENV, NEAR_NETWORK: "testnet" });
  assert.equal(c.refExchangeId, "ref-finance.testnet");
  assert.equal(c.dclExchangeId, "dclv2.ref-labs.testnet");
  assert.equal(c.wnearId, "wrap.testnet");
  assert.equal(c.registrarId, "testnet");
  assert.equal(c.nameSuffix, ".testnet");
  assert.equal(c.payCurrencies.find((p) => p.id === "USDC")?.contractId, "usdc.fakes.testnet");
  assert.equal(c.payCurrencies.find((p) => p.id === "USDT")?.contractId, "usdt.fakes.testnet");
  assert.deepEqual(c.nearRpcUrls, [
    "https://rpc.testnet.fastnear.com",
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://rpc.testnet.near.org",
  ]);
});

test("per trade cap defaults to 5 NEAR on mainnet and 10 on testnet, env wins", () => {
  assert.equal(loadConfig({ ...BASE_ENV, NEAR_NETWORK: "mainnet" }).maxTradeNear, 5);
  assert.equal(loadConfig({ ...BASE_ENV, NEAR_NETWORK: "testnet" }).maxTradeNear, 10);
  assert.equal(loadConfig({ ...BASE_ENV, NEAR_NETWORK: "mainnet", MAX_TRADE_NEAR: "7" }).maxTradeNear, 7);
});

test("pool scan bounds follow the network scale", () => {
  const m = loadConfig({ ...BASE_ENV, NEAR_NETWORK: "mainnet" });
  assert.ok(m.simplePoolScanLimit >= 9014, "mainnet simple bound must cover the full pool list");
  assert.ok(m.dclPoolScanLimit >= 6300, "mainnet DCL bound must cover the full pool list");
  const t = loadConfig({ ...BASE_ENV, NEAR_NETWORK: "testnet" });
  assert.equal(t.simplePoolScanLimit, 500);
  assert.equal(t.dclPoolScanLimit, 2000);
});

test("TRADING_ENABLED defaults on and only a clear negative pauses trading", () => {
  assert.equal(parseTradingEnabled(undefined), true);
  assert.equal(parseTradingEnabled("true"), true);
  assert.equal(parseTradingEnabled("false"), false);
  assert.equal(parseTradingEnabled("FALSE"), false);
  assert.equal(parseTradingEnabled("0"), false);
  assert.equal(parseTradingEnabled("off"), false);
  assert.equal(loadConfig({ ...BASE_ENV }).tradingEnabled, true);
  assert.equal(loadConfig({ ...BASE_ENV, TRADING_ENABLED: "false" }).tradingEnabled, false);
});

test("trading gate refuses buys and sells plainly while paused", async () => {
  const user = { telegramId: 42, tokens: {} } as unknown as UserRecord;
  const mutable = config as { tradingEnabled: boolean };
  mutable.tradingEnabled = false;
  try {
    assert.throws(() => assertTradingEnabled(), /Trading is paused/);
    await assert.rejects(executeBuy(user, "wrap.testnet", 0.1, "NEAR"), /Trading is paused/);
    await assert.rejects(executeSell(user, "wrap.testnet", 1, "NEAR"), /Trading is paused/);
  } finally {
    mutable.tradingEnabled = true;
  }
  assert.doesNotThrow(() => assertTradingEnabled());
});

test("PnL network pill and caption follow the network", () => {
  assert.equal(networkPill("mainnet"), "NEAR");
  assert.equal(networkPill("testnet"), "NEAR TESTNET");
  assert.equal(networkCaptionName("mainnet"), "NEAR");
  assert.equal(networkCaptionName("testnet"), "NEAR testnet");
  // The running config in tests is testnet, so the caption says so.
  const caption = pnlCaption({
    symbol: "TEST",
    pnlPct: 10,
    entryMcUsd: 1,
    currentMcUsd: 2,
    botUsername: "VelocityTestBot",
  });
  assert.match(caption, /NEAR testnet/);
});
