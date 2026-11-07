import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { costBasisFromTrades, fmtPct, pnlTier, renderPnlCard } from "../src/share/pnl";
import type { TradeRecord } from "../src/store";

test("tier selection matches the Forge thresholds", () => {
  assert.equal(pnlTier(500).id, "legendary");
  assert.equal(pnlTier(1200).id, "legendary");
  assert.equal(pnlTier(499.9).id, "diamond");
  assert.equal(pnlTier(100).id, "diamond");
  assert.equal(pnlTier(99.9).id, "solid");
  assert.equal(pnlTier(25).id, "solid");
  assert.equal(pnlTier(24.9).id, "green");
  assert.equal(pnlTier(0).id, "green");
  assert.equal(pnlTier(-0.01).id, "rekt");
  assert.equal(pnlTier(-90).id, "rekt");
});

test("tier colors match the spec", () => {
  assert.equal(pnlTier(600).color, "#FFD54A"); // gold
  assert.equal(pnlTier(150).color, "#FF9E2C"); // orange
  assert.equal(pnlTier(30).color, "#7CFC66"); // green
  assert.equal(pnlTier(5).color, "#C4F56B"); // light green
  assert.equal(pnlTier(-5).color, "#FF5C5C"); // red
  assert.equal(pnlTier(600).label, "LEGENDARY");
  assert.equal(pnlTier(150).label, "DIAMOND HANDS");
  assert.equal(pnlTier(30).label, "SOLID");
  assert.equal(pnlTier(5).label, "GREEN");
  assert.equal(pnlTier(-5).label, "REKT");
});

test("percent formatting", () => {
  assert.equal(fmtPct(91.14), "+91.1%");
  assert.equal(fmtPct(-12.36), "-12.4%");
  assert.equal(fmtPct(0), "+0.0%");
});

function trade(partial: Partial<TradeRecord>): TradeRecord {
  return {
    at: new Date().toISOString(),
    telegramId: 1,
    side: "buy",
    tokenId: "token.testnet",
    symbol: "TOKEN",
    payAmount: 0,
    payCurrency: "NEAR",
    nearValue: 0,
    tokenAmount: 0,
    priceNear: 0,
    feeNear: 0,
    txids: [],
    ...partial,
  };
}

test("average cost basis blends all buys and ignores sells", () => {
  const trades = [
    trade({ side: "buy", tokenAmount: 100, nearValue: 10 }),
    trade({ side: "buy", tokenAmount: 50, nearValue: 10 }),
    trade({ side: "sell", tokenAmount: 20, nearValue: 4 }),
    trade({ side: "buy", tokenId: "other.testnet", tokenAmount: 999, nearValue: 999 }),
  ];
  const basis = costBasisFromTrades(trades, "token.testnet");
  assert.ok(basis);
  assert.equal(basis.bought, 150);
  assert.ok(Math.abs(basis.avgPriceNear - 20 / 150) < 1e-12);
});

test("cost basis is undefined with no buys", () => {
  assert.equal(costBasisFromTrades([], "token.testnet"), undefined);
  assert.equal(
    costBasisFromTrades([trade({ side: "sell", tokenAmount: 5, nearValue: 1 })], "token.testnet"),
    undefined,
  );
});

test("card renders as a valid 1200x630 PNG for every tier", async () => {
  for (const pnlPct of [640, 150, 42, 8, -35]) {
    const png = await renderPnlCard({
      symbol: "TEST",
      pnlPct,
      entryMcUsd: 120_000,
      currentMcUsd: 890_000,
      botUsername: "VelocityTestBot",
      referralTag: "r_42",
    });
    assert.equal(png.subarray(0, 4).toString("hex"), "89504e47"); // PNG magic
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
    assert.equal(meta.format, "png");
  }
});
