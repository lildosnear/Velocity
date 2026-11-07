import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserRecord } from "../src/store";

/**
 * Live AI copy trading proof for testnet. Run: npm run copy-proof
 *
 * The one Velocity flow that had never been run end to end live:
 * a watched trader trades, and the bot copies the trade through the
 * user's separate AI wallet on its own. This script runs that whole
 * chain with the bot's real modules, no fakes in the money path:
 *
 * 1. A fresh "trader" account is funded with test NEAR from the repo
 *    proof wallet (user 0 in the real data/store.json).
 * 2. A proof bot user is created in a SCRATCH store (a temp DATA_DIR;
 *    the real store is only ever read, for the proof wallet's key):
 *    a main wallet and a separate AI wallet, recorded exactly the way
 *    /ai setup records it (per trade 0.1 NEAR, daily loss limit 5
 *    NEAR), funded exactly the way /ai setup tells the user to fund
 *    it (send NEAR to the AI account id), and a watch on the trader
 *    in auto mode, recorded exactly the way /watch writes it.
 * 3. Notifications are wired to the console through the same
 *    setSender / setAlertSender hooks index.ts wires to Telegram, so
 *    what prints here is what the user would receive.
 * 4. A baseline watcher tick runs (no actions, as designed). The
 *    trader then buys BANANA on pool 11 with 0.2 NEAR through the
 *    bot's own swapBuy. Real watcher ticks poll until the copy lands:
 *    the AI wallet must hold BANANA bought at the configured per
 *    trade size, a position record must exist, and the main wallet
 *    must be untouched to the yocto.
 * 5. The trader sells half their BANANA. Ticks poll again: the AI
 *    must sell about half its position (proportional copy), proceeds
 *    must arrive, the position record must shrink to match the chain,
 *    and the daily loss guard must not have tripped.
 * 6. Guard: a second scratch user whose per trade size is set ABOVE
 *    MAX_TRADE_NEAR, with an AI wallet funded well past that size,
 *    watches the same trader. The trader buys again. The copy must
 *    be refused by the per trade cap before anything is signed (the
 *    AI balance afterwards is exactly what it was), with the refusal
 *    notification shown. The guard funds are then swept back to the
 *    proof wallet.
 *
 * Every assertion prints PASS or FAIL; the script exits nonzero if
 * any check fails. All funds are testnet play money.
 */

const BANANA_ID = "banana.ft-fin.testnet";
const USER_ID = 990101;
const GUARD_USER_ID = 990102;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures += 1;
}

async function main() {
  // Scratch store first: DATA_DIR must be set before any src module
  // loads, because config reads the environment at import time. That
  // is why every src import below is dynamic.
  const scratch = mkdtempSync(join(tmpdir(), "velocity-copy-proof-"));
  process.env.DATA_DIR = scratch;
  console.log(`Scratch DATA_DIR: ${scratch} (the real store is only read, never written)`);

  const { config } = await import("../src/config");
  const { store } = await import("../src/store");
  const { encryptPrivateKey, decryptPrivateKey } = await import("../src/crypto");
  const { createWallet, transferNear, readNearBalance, readNearBalanceYocto, readFtBalanceRaw } =
    await import("../src/near");
  const { swapBuy, swapSell, resolveToken, getFeeWallet } = await import("../src/market");
  const { findRoute } = await import("../src/ref");
  const { watchTick } = await import("../src/watcher");
  const { aiActive } = await import("../src/copy");
  const { setSender, setAlertSender } = await import("../src/notifier");

  if (config.network !== "testnet") throw new Error("copy-proof is a testnet proof; set NEAR_NETWORK=testnet.");

  // The funding source: the repo proof wallet (user 0) from the REAL
  // store file, read directly so the scratch store stays the only
  // store this process writes.
  const realStore = JSON.parse(readFileSync(join(process.cwd(), "data", "store.json"), "utf8"));
  const proofRecord = realStore.users?.["0"];
  if (!proofRecord) throw new Error("No proof wallet (user 0) in data/store.json. Run npm run live-swap once first.");
  const proofCreds = { accountId: proofRecord.accountId as string, secret: decryptPrivateKey(proofRecord.encSecret) };
  const proofBalance = await readNearBalance(proofCreds.accountId);
  console.log(`Proof wallet ${proofCreds.accountId}: ${proofBalance.toFixed(4)} NEAR`);
  if (proofBalance < 20) throw new Error("Proof wallet needs at least 20 test NEAR for this proof (guard wallet included).");

  const token = await resolveToken(BANANA_ID);
  console.log(`Token: ${token.symbol} (${token.id}), ${token.decimals} decimals`);

  // Notifications to console, through the same hooks the bot wires.
  const notices: string[] = [];
  setSender(async (_id, text) => {
    notices.push(text);
    console.log(`[notify] ${text}`);
  });
  setAlertSender(async (_id, text) => {
    notices.push(text);
    console.log(`[alert] ${text}`);
    return { chatId: _id, messageId: notices.length };
  });

  // --- Setup: trader, bot user, AI wallet, watch -------------------
  const trader = createWallet();
  const fundTraderTx = await transferNear(proofCreds, trader.accountId, 3n * 10n ** 24n);
  console.log(`Trader ${trader.accountId} funded with 3 NEAR (tx ${fundTraderTx})`);
  const traderCreds = { accountId: trader.accountId, secret: trader.secret };

  const mainWallet = createWallet();
  const aiWallet = createWallet();
  // Recorded exactly as /start plus /ai setup record them.
  const user: UserRecord = {
    telegramId: USER_ID,
    accountId: mainWallet.accountId,
    encSecret: encryptPrivateKey(mainWallet.secret),
    payCurrency: "NEAR",
    tokens: {},
    ai: {
      enabled: true,
      accountId: aiWallet.accountId,
      encSecret: encryptPrivateKey(aiWallet.secret),
      perTradeAmount: 0.1,
      dailyLossLimitNear: 5,
      positions: [],
      dailyPnl: { date: "1970-01-01", realizedNear: 0 },
    },
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  const fundMainTx = await transferNear(proofCreds, mainWallet.accountId, 1n * 10n ** 24n);
  const fundAiTx = await transferNear(proofCreds, aiWallet.accountId, 2n * 10n ** 24n);
  console.log(`Bot user main wallet funded 1 NEAR (tx ${fundMainTx}); AI wallet funded 2 NEAR (tx ${fundAiTx})`);
  console.log(`AI wallet: ${aiWallet.accountId}`);

  // Recorded exactly as /watch <trader> auto writes it.
  const watchId = `${USER_ID}:${trader.accountId.toLowerCase()}`;
  store.watch({
    id: watchId,
    ownerTelegramId: USER_ID,
    accountId: trader.accountId.toLowerCase(),
    mode: "auto",
    createdAt: new Date().toISOString(),
  });

  const mainYoctoBefore = await readNearBalanceYocto(mainWallet.accountId);

  async function tickUntil(label: string, predicate: () => Promise<boolean>, maxTicks = 15): Promise<void> {
    for (let i = 1; i <= maxTicks; i++) {
      await watchTick();
      if (await predicate()) {
        console.log(`${label}: detected on tick ${i}`);
        return;
      }
      await sleep(3000);
    }
    throw new Error(`${label}: not detected after ${maxTicks} watcher ticks`);
  }

  // --- Baseline tick: no actions, as designed ----------------------
  await watchTick();
  const aiBanana0 = await readFtBalanceRaw(token.id, aiWallet.accountId);
  check("baseline tick copies nothing", aiBanana0 === 0n && (store.getUser(USER_ID)?.ai?.positions.length ?? 0) === 0);

  // --- Trader buys, AI copies --------------------------------------
  console.log(`Trader buying BANANA with 0.2 NEAR...`);
  const traderBuy = await swapBuy(traderCreds, token, 0.2, "NEAR", config.botFeeBps);
  console.log(`Trader buy landed. Tx: ${traderBuy.txids.join(", ")}`);
  console.log(`Trader received ${traderBuy.tokenAmount} ${token.symbol}`);

  // What the copy should receive: a fresh quote for the per trade
  // size, net of the bot fee when a fee wallet is configured.
  const feeFraction = getFeeWallet() ? config.botFeeBps / 10_000 : 0;
  const copyInputRaw = BigInt(Math.floor(0.1 * (1 - feeFraction) * 1e6)) * 10n ** 18n;
  const quote = await findRoute(config.wnearId, token.id, copyInputRaw);
  const quotedOut = Number(quote.amountOutRaw) / 10 ** token.decimals;
  console.log(`Fresh quote for the 0.1 NEAR copy: ${quotedOut.toFixed(2)} ${token.symbol} via ${quote.description}`);

  await tickUntil("copy buy", async () => (await readFtBalanceRaw(token.id, aiWallet.accountId)) > 0n);

  const aiBananaAfterBuy = await readFtBalanceRaw(token.id, aiWallet.accountId);
  const aiBananaHuman = Number(aiBananaAfterBuy) / 10 ** token.decimals;
  check("AI wallet holds BANANA after the copy", aiBananaAfterBuy > 0n, `${aiBananaHuman.toFixed(2)} ${token.symbol}`);
  check(
    "copy received within 5% of the fresh quote",
    Math.abs(aiBananaHuman - quotedOut) / quotedOut <= 0.05,
    `got ${aiBananaHuman.toFixed(2)}, quoted ${quotedOut.toFixed(2)}`,
  );

  const userAfterBuy = store.getUser(USER_ID);
  const posAfterBuy = userAfterBuy?.ai?.positions.find((p) => p.tokenId === token.id);
  check("a copy position record exists", !!posAfterBuy, posAfterBuy ? `${posAfterBuy.amount.toFixed(2)} ${posAfterBuy.symbol}` : "none");
  if (posAfterBuy) {
    check(
      "position amount matches the chain balance",
      Math.abs(posAfterBuy.amount - aiBananaHuman) / aiBananaHuman <= 0.01,
      `record ${posAfterBuy.amount.toFixed(2)} vs chain ${aiBananaHuman.toFixed(2)}`,
    );
    check("position names the watched wallet", posAfterBuy.watchedWalletId === watchId);
  }
  check(
    "main wallet untouched by the copy, to the yocto",
    (await readNearBalanceYocto(mainWallet.accountId)) === mainYoctoBefore,
  );
  check("main wallet holds no BANANA", (await readFtBalanceRaw(token.id, mainWallet.accountId)) === 0n);
  const buyTrade = store.userTrades(USER_ID).find((t) => t.viaAi && t.side === "buy");
  check("copy buy is in the trade log as an AI trade", !!buyTrade, buyTrade ? `tx ${buyTrade.txids.join(", ")}` : "none");
  check("the user was told about the copy buy", notices.some((n) => n.includes("AI copied buy")));

  // --- Trader sells half, AI copies proportionally -----------------
  const traderBanana = Number(await readFtBalanceRaw(token.id, trader.accountId)) / 10 ** token.decimals;
  const traderSellAmount = traderBanana / 2;
  console.log(`Trader selling half their BANANA (${traderSellAmount.toFixed(2)} of ${traderBanana.toFixed(2)})...`);
  const aiNearBeforeSell = await readNearBalance(aiWallet.accountId);
  const traderSell = await swapSell(traderCreds, token, traderSellAmount, "NEAR", config.botFeeBps);
  console.log(`Trader sell landed. Tx: ${traderSell.txids.join(", ")}`);
  console.log(`Trader received ${traderSell.payAmount} NEAR`);

  await tickUntil("copy sell", async () => {
    const now = await readFtBalanceRaw(token.id, aiWallet.accountId);
    return now < aiBananaAfterBuy;
  });

  const aiBananaAfterSell = await readFtBalanceRaw(token.id, aiWallet.accountId);
  const keptFraction = Number(aiBananaAfterSell) / Number(aiBananaAfterBuy);
  check(
    "AI sold about half its position (proportional copy)",
    keptFraction >= 0.44 && keptFraction <= 0.56,
    `kept ${(keptFraction * 100).toFixed(1)}%`,
  );
  const userAfterSell = store.getUser(USER_ID);
  const posAfterSell = userAfterSell?.ai?.positions.find((p) => p.tokenId === token.id);
  const aiBananaHumanAfterSell = Number(aiBananaAfterSell) / 10 ** token.decimals;
  check(
    "position record shrank to match the chain",
    !!posAfterSell && Math.abs(posAfterSell.amount - aiBananaHumanAfterSell) / aiBananaHumanAfterSell <= 0.01,
    posAfterSell ? `record ${posAfterSell.amount.toFixed(2)} vs chain ${aiBananaHumanAfterSell.toFixed(2)}` : "position missing",
  );
  const sellTrade = store.userTrades(USER_ID).find((t) => t.viaAi && t.side === "sell");
  check("copy sell is in the trade log as an AI trade", !!sellTrade, sellTrade ? `tx ${sellTrade.txids.join(", ")}` : "none");
  if (sellTrade) check("copy sell proceeds are positive", sellTrade.payAmount > 0, `${sellTrade.payAmount.toFixed(4)} NEAR`);
  const aiNearAfterSell = await readNearBalance(aiWallet.accountId);
  check(
    "AI NEAR balance reflects the sale (proceeds less gas)",
    aiNearAfterSell > aiNearBeforeSell - 0.02,
    `${aiNearBeforeSell.toFixed(4)} -> ${aiNearAfterSell.toFixed(4)} NEAR`,
  );
  check("the user was told about the copy sell", notices.some((n) => n.includes("AI sold")));
  check(
    "daily loss guard did not trip and the AI is still active",
    !userAfterSell?.ai?.pausedUntil && !!userAfterSell && !!aiActive(userAfterSell),
    `today's realized P&L ${userAfterSell?.ai?.dailyPnl.realizedNear.toFixed(6)} NEAR against a 5 NEAR limit`,
  );
  check(
    "main wallet still untouched after the sell",
    (await readNearBalanceYocto(mainWallet.accountId)) === mainYoctoBefore,
  );

  // --- Guard: per trade size above MAX_TRADE_NEAR ------------------
  console.log(`Guard phase: a user with per trade size ${config.maxTradeNear + 1} NEAR (cap ${config.maxTradeNear})...`);
  const guardMain = createWallet();
  const guardAi = createWallet();
  const guardUser: UserRecord = {
    telegramId: GUARD_USER_ID,
    accountId: guardMain.accountId,
    encSecret: encryptPrivateKey(guardMain.secret),
    payCurrency: "NEAR",
    tokens: {},
    ai: {
      enabled: true,
      accountId: guardAi.accountId,
      encSecret: encryptPrivateKey(guardAi.secret),
      perTradeAmount: config.maxTradeNear + 1,
      dailyLossLimitNear: 50,
      positions: [],
      dailyPnl: { date: "1970-01-01", realizedNear: 0 },
    },
    createdAt: new Date().toISOString(),
  };
  store.saveUser(guardUser);
  const guardFundTx = await transferNear(proofCreds, guardAi.accountId, BigInt(config.maxTradeNear + 2) * 10n ** 24n);
  console.log(`Guard AI wallet funded with ${config.maxTradeNear + 2} NEAR (tx ${guardFundTx}), past its own per trade size`);
  store.watch({
    id: `${GUARD_USER_ID}:${trader.accountId.toLowerCase()}`,
    ownerTelegramId: GUARD_USER_ID,
    accountId: trader.accountId.toLowerCase(),
    mode: "auto",
    createdAt: new Date().toISOString(),
  });
  await watchTick(); // baseline for the guard watch; nothing may copy
  const guardYoctoBefore = await readNearBalanceYocto(guardAi.accountId);

  console.log(`Trader buying BANANA with 0.2 NEAR again...`);
  const traderBuy2 = await swapBuy(traderCreds, token, 0.2, "NEAR", config.botFeeBps);
  console.log(`Trader buy 2 landed. Tx: ${traderBuy2.txids.join(", ")}`);
  const noticesBeforeGuard = notices.length;
  await tickUntil("guard refusal", async () =>
    notices.slice(noticesBeforeGuard).some((n) => n.includes("per trade cap")),
  );
  check(
    "the over cap copy was refused with a plain message",
    notices.some((n) => n.includes("AI copy skipped") && n.includes("per trade cap")),
  );
  check(
    "guard AI wallet signed nothing: balance exact, no BANANA, no position",
    (await readNearBalanceYocto(guardAi.accountId)) === guardYoctoBefore &&
      (await readFtBalanceRaw(token.id, guardAi.accountId)) === 0n &&
      (store.getUser(GUARD_USER_ID)?.ai?.positions.length ?? 0) === 0,
  );

  // Sweep the guard funds home; testnet play money should not strand.
  const guardBalance = await readNearBalanceYocto(guardAi.accountId);
  const sweepTx = await transferNear(
    { accountId: guardAi.accountId, secret: guardAi.secret },
    proofCreds.accountId,
    guardBalance - 10n ** 22n,
  );
  console.log(`Guard funds swept back to the proof wallet (tx ${sweepTx})`);

  // --- Summary ------------------------------------------------------
  const finalUser = store.getUser(USER_ID);
  console.log("\n=== Copy proof summary ===");
  console.log(`Trader buy tx:  ${traderBuy.txids.join(", ")}`);
  console.log(`Copy buy tx:    ${buyTrade?.txids.join(", ") ?? "none"}`);
  console.log(`Trader sell tx: ${traderSell.txids.join(", ")}`);
  console.log(`Copy sell tx:   ${sellTrade?.txids.join(", ") ?? "none"}`);
  console.log(
    `AI wallet: 2 NEAR in, bought ${aiBananaHuman.toFixed(2)} BANANA for 0.1 NEAR, sold half back, ` +
      `position now ${finalUser?.ai?.positions.find((p) => p.tokenId === token.id)?.amount.toFixed(2) ?? "0"} BANANA, ` +
      `NEAR balance ${aiNearAfterSell.toFixed(4)}`,
  );
  console.log(`Main wallet: funded 1 NEAR, never signed a thing, balance unchanged to the yocto.`);
  if (failures > 0) throw new Error(`${failures} check(s) failed.`);
  console.log("Proof complete: AI copy trading works end to end on testnet.");
}

main().catch((err) => {
  console.error("copy-proof failed:", err?.message ?? err);
  process.exit(1);
});
