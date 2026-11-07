import { config, getPayCurrency, payCurrencyTokenId } from "./config";
import { decryptPrivateKey } from "./crypto";
import { store, type AiConfig, type CopyPosition, type UserRecord } from "./store";
import { UserBusyError, withUserLock } from "./locks";
import { notify } from "./notifier";
import { payBalance, swapBuy, swapSell } from "./market";
import { getTokenPriceNear, tokenDecimals } from "./prices";
import type { WalletCreds } from "./near";
import type { WalletTradeEvent } from "./watcher";

/**
 * The AI copy trading engine, ported from Forge.
 *
 * - Each user has ONE AI wallet, funded only with what they set aside.
 *   The AI can never touch the main hot wallet. The funding IS the max risk.
 * - Per watched wallet in "auto" mode: trader buys, AI buys perTradeAmount
 *   worth (in the user's pay currency); trader sells, AI sells the same
 *   fraction of its position.
 * - Daily loss limit: when today's realized losses hit it, auto mode pauses
 *   until midnight UTC and the user is notified.
 * - Optional stop loss per position, checked every watcher tick against
 *   live pool prices.
 * - AI trades pay the full bot fee and are excluded from the referral
 *   program entirely: no discount, no referrer credit, no count.
 */

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function short(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
}

function aiCreds(ai: AiConfig): WalletCreds {
  return { accountId: ai.accountId, secret: decryptPrivateKey(ai.encSecret) };
}

/** Returns the AI config only if auto mode is currently allowed to act. */
export function aiActive(user: UserRecord): AiConfig | undefined {
  const ai = user.ai;
  if (!ai?.enabled) return undefined;
  if (ai.pausedUntil) {
    if (Date.now() < Date.parse(ai.pausedUntil)) return undefined;
    ai.pausedUntil = undefined; // pause expired
    store.saveUser(user);
  }
  return ai;
}

function recordDailyPnl(user: UserRecord, ai: AiConfig, realizedNear: number): void {
  const today = todayStr();
  if (ai.dailyPnl.date !== today) ai.dailyPnl = { date: today, realizedNear: 0 };
  ai.dailyPnl.realizedNear += realizedNear;
  store.saveUser(user);
}

/** Returns true if the daily loss limit was just hit (pauses the AI). */
function checkDailyLimit(user: UserRecord, ai: AiConfig): boolean {
  const limit = ai.dailyLossLimitNear;
  if (limit == null || limit <= 0) return false;
  const today = todayStr();
  if (ai.dailyPnl.date !== today || ai.dailyPnl.realizedNear > -limit) return false;
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  ai.pausedUntil = tomorrow.toISOString();
  store.saveUser(user);
  void notify(
    user.telegramId,
    `AI paused: daily loss limit of ${limit} NEAR hit ` +
      `(today: ${ai.dailyPnl.realizedNear.toFixed(6)} NEAR). Resumes at midnight UTC. Use /ai on to resume early.`,
  );
  return true;
}

/** Trader bought -> AI buys perTradeAmount worth (in the user's pay currency). */
export async function onTraderBuy(event: WalletTradeEvent): Promise<void> {
  if (!config.tradingEnabled) return; // trading paused: copy executions stay quiet, alerts still flow
  const user = store.getUser(event.wallet.ownerTelegramId);
  const ai = user && aiActive(user);
  if (!user || !ai) return;
  // One money operation at a time for this user (see locks.ts): a
  // copy that lands while the user is mid trade is refused with
  // UserBusyError, which the watcher turns into a plain message,
  // instead of racing the user's own trade.
  await withUserLock(user.telegramId, async () => {
    const currencyId = user.payCurrency;
    const token = event.token;
    if (token.id === payCurrencyTokenId(currencyId)) return; // trader moved the pay token itself, nothing to copy

    const creds = aiCreds(ai);
    const balance = await payBalance(creds, currencyId);
    if (balance < ai.perTradeAmount) {
      await notify(
        user.telegramId,
        `AI wallet is low on ${currencyId} (${balance.toFixed(4)} < per trade ${ai.perTradeAmount}). ` +
          `Top it up: ${ai.accountId}`,
      );
      return;
    }

    const result = await swapBuy(creds, token, ai.perTradeAmount, currencyId, config.botFeeBps);

    const existing = ai.positions.find((p) => p.tokenId === token.id);
    if (existing) {
      const total = existing.amount + result.tokenAmount;
      existing.entryPriceNear =
        (existing.amount * existing.entryPriceNear + result.tokenAmount * result.priceNear) / total;
      existing.amount = total;
    } else {
      ai.positions.push({
        tokenId: token.id,
        symbol: token.symbol,
        amount: result.tokenAmount,
        entryPriceNear: result.priceNear,
        payCurrency: currencyId,
        watchedWalletId: event.wallet.id,
        openedAt: new Date().toISOString(),
      });
    }
    user.tokens[token.id] = token;
    store.saveUser(user);
    store.logTrade({
      at: new Date().toISOString(), telegramId: user.telegramId, side: "buy",
      tokenId: token.id, symbol: token.symbol, payAmount: result.payAmount,
      payCurrency: currencyId, nearValue: result.nearValue, tokenAmount: result.tokenAmount,
      priceNear: result.priceNear, feeNear: result.feeNear, poolKind: result.poolKind, viaAi: true, txids: result.txids,
    });
    await notify(
      user.telegramId,
      `AI copied buy: ${result.tokenAmount.toFixed(2)} ${token.symbol} for ${ai.perTradeAmount} ${currencyId} ` +
        `(trader ${short(event.wallet.accountId)} bought ${event.amountTokens.toFixed(2)}).`,
    );
  });
}

/**
 * Close part or all of a copy position, paying out in the position's own
 * pay currency. Sells are proportional: if the watched trader sold 40
 * percent of their holdings, we sell 40 percent of our position, never
 * the whole thing unless they did.
 */
async function closePosition(
  user: UserRecord,
  ai: AiConfig,
  pos: CopyPosition,
  sellAmount: number,
  reason: string,
): Promise<void> {
  sellAmount = Math.min(sellAmount, pos.amount);
  if (!(sellAmount > 0)) return;
  if (!config.tradingEnabled) return; // trading paused (also covers stop loss closes)
  const creds = aiCreds(ai);
  const token = { id: pos.tokenId, symbol: pos.symbol, decimals: await tokenDecimals(pos.tokenId) };
  const result = await swapSell(creds, token, sellAmount, pos.payCurrency, config.botFeeBps);

  const realizedNear = result.nearValue - sellAmount * pos.entryPriceNear;
  pos.amount -= sellAmount;
  if (pos.amount <= 1e-9) {
    ai.positions = ai.positions.filter((p) => p !== pos);
  }
  recordDailyPnl(user, ai, realizedNear);
  store.saveUser(user);
  store.logTrade({
    at: new Date().toISOString(), telegramId: user.telegramId, side: "sell",
    tokenId: pos.tokenId, symbol: pos.symbol, payAmount: result.payAmount,
    payCurrency: pos.payCurrency, nearValue: result.nearValue, tokenAmount: sellAmount,
    priceNear: result.priceNear, feeNear: result.feeNear, poolKind: result.poolKind, viaAi: true, txids: result.txids,
  });
  const pnlStr = `${realizedNear >= 0 ? "+" : ""}${realizedNear.toFixed(6)} NEAR`;
  await notify(
    user.telegramId,
    `AI sold ${sellAmount.toFixed(2)} ${pos.symbol} for ${result.payAmount.toFixed(4)} ${pos.payCurrency} (${reason}). P&L: ${pnlStr}.`,
  );
  checkDailyLimit(user, ai);
}

/** Trader sold -> AI sells the SAME FRACTION of its position. */
export async function onTraderSell(event: WalletTradeEvent): Promise<void> {
  if (!config.tradingEnabled) return; // trading paused: copy executions stay quiet, alerts still flow
  const user = store.getUser(event.wallet.ownerTelegramId);
  const ai = user && aiActive(user);
  if (!user || !ai) return;
  // Same per user lock as onTraderBuy (see locks.ts).
  await withUserLock(user.telegramId, async () => {
    const pos = ai.positions.find((p) => p.tokenId === event.token.id);
    if (!pos) {
      await notify(
        user.telegramId,
        `Trader ${short(event.wallet.accountId)} sold ${event.token.symbol}, but the AI holds no open position in it.`,
      );
      return;
    }
    const fraction = event.beforeTokens > 0 ? Math.min(1, event.amountTokens / event.beforeTokens) : 1;
    await closePosition(
      user, ai, pos, pos.amount * fraction,
      `copied ${(fraction * 100).toFixed(0)}% sell from ${short(event.wallet.accountId)}`,
    );
  });
}

/** Stop loss checker, call every watcher tick. */
export async function stopLossTick(): Promise<void> {
  for (const user of store.allUsers()) {
    const ai = aiActive(user);
    if (!ai?.stopLossPct || ai.stopLossPct <= 0) continue;
    for (const pos of [...ai.positions]) {
      let price: number;
      try {
        price = await getTokenPriceNear(pos.tokenId);
      } catch {
        continue;
      }
      if (price <= pos.entryPriceNear * (1 - ai.stopLossPct)) {
        const stopPct = ai.stopLossPct; // narrowed by the guard above; captured for the closure
        try {
          // Stop loss closes take the same per user lock as every
          // other money operation; a busy user just skips this tick
          // (the price is rechecked next tick), it is not a failure.
          await withUserLock(user.telegramId, () =>
            closePosition(user, ai, pos, pos.amount, `stop loss at ${(stopPct * 100).toFixed(0)}%`),
          );
        } catch (err: any) {
          if (err instanceof UserBusyError) continue;
          await notify(user.telegramId, `Stop loss failed for ${pos.symbol}: ${err?.message ?? err}`);
        }
      }
    }
  }
}
