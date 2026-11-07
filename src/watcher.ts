import { InlineKeyboard } from "grammy";
import { config } from "./config";
import { readFtBalanceRaw, rpcBlockHeight } from "./near";
import {
  type PendingAlert,
  type PendingAlertLeg,
  type PendingAlertToken,
  type TradedToken,
  type UserRecord,
  type WatchedWallet,
} from "./store";
import { newPendingAlertId, store } from "./store";
import { logError } from "./log";
import { notify, notifyAlert, type SentMessageRef } from "./notifier";
import { onTraderBuy, onTraderSell } from "./copy";
import { watchTokenSet } from "./discovery";

/**
 * Watches ONLY the wallets users explicitly assigned (max 5 per user).
 *
 * Each tick we read fungible token balances for the watched account ids,
 * one ft_balance_of call per token in the watch set. The watch set is
 * the registry plus every token discovered in a simple or DCL pool
 * paired with wNEAR or a registry token (see discovery.ts), so a trader
 * moving a token the bot has never traded still shows up. Only watched
 * accounts are ever queried, no global scan. Balance up means buy, down
 * means sell. The first poll per wallet only snapshots, so old activity
 * never alerts.
 *
 * Alerts: all of an account's diffs in one tick are composed into ONE
 * message, sells stated before buys. wNEAR is the payment rail of most
 * swaps, so when any other token moved in the same tick the wNEAR leg
 * is left out of the text; a tick where only wNEAR moved (a wrap, an
 * unwrap, a plain transfer) still alerts on its own. The copy engine
 * is unaffected: it keeps consuming the per token diffs one by one.
 * Each alert also carries Buy, Sell and Ignore buttons for its
 * receiver only (see buildAlertKeyboard and the pending alert
 * records in the store); the taps are handled in commands.ts. A Sell
 * button mirrors the trader's move proportionally: it sells the
 * same fraction of the receiver's own holding that the trader sold
 * of theirs.
 *
 * Honest limits:
 * - We cannot distinguish a buy from a plain transfer in (or a sell from
 *   a transfer out). Alerts say "bought" and "sold" for either.
 * - The discovered set is capped (WATCH_DISCOVERY_MAX) and refreshed on
 *   a cache, so a token in a brand new pool can take one refresh cycle
 *   to appear.
 */

export interface WalletTradeEvent {
  wallet: WatchedWallet;
  token: TradedToken;
  side: "buy" | "sell";
  amountTokens: number; // human units, absolute size of the change
  beforeTokens: number; // human units, balance before the change
  afterTokens: number; // human units, balance after the change
}

export interface Holding {
  token: TradedToken;
  amountTokens: number;
}

/** Token balances for ONE account across the watch set: token id -> raw amount. */
export async function scanWalletBalances(accountId: string, tokens?: TradedToken[]): Promise<Map<string, bigint>> {
  const set = tokens ?? (await watchTokenSet());
  const out = new Map<string, bigint>();
  for (const token of set) {
    try {
      const raw = await readFtBalanceRaw(token.id, accountId);
      if (raw > 0n) out.set(token.id, raw);
    } catch {
      // A token contract that errors for this account reads as zero here.
      continue;
    }
  }
  return out;
}

/** All watch set tokens an account holds, with human readable amounts. */
export async function getHoldings(accountId: string): Promise<Holding[]> {
  const tokens = await watchTokenSet();
  const balances = await scanWalletBalances(accountId, tokens);
  const registry = new Map(tokens.map((t) => [t.id, t]));
  const out: Holding[] = [];
  for (const [tokenId, raw] of balances) {
    const token = registry.get(tokenId);
    if (!token) continue;
    out.push({ token, amountTokens: Number(raw) / 10 ** token.decimals });
  }
  return out.sort((a, b) => b.amountTokens - a.amountTokens);
}

let last = new Map<string, Map<string, bigint>>(); // watched id -> token id -> raw
let initializedWallets = new Set<string>();

/**
 * The in memory snapshots above are a cache of the persisted watcher
 * progress (see WatchProgress in store.ts). On a cold start the first
 * tick for a wallet hydrates its snapshot from the store, so a bot
 * restart or crash resumes diffing where the last completed tick left
 * off: moves handled before the restart are never re-alerted or
 * re-copied, and moves that happened while the bot was down are
 * picked up by the first tick back. Only a wallet with no persisted
 * progress at all takes the baseline snapshot (no alerts for past
 * activity), exactly as newly watched wallets always have.
 */
function hydrateProgress(watchId: string): Map<string, bigint> | undefined {
  if (initializedWallets.has(watchId)) return last.get(watchId);
  const progress = store.getWatchProgress(watchId);
  if (!progress) return undefined;
  const map = new Map<string, bigint>();
  for (const [tokenId, raw] of Object.entries(progress.balances)) {
    try {
      const value = BigInt(raw);
      if (value > 0n) map.set(tokenId, value);
    } catch {
      // A malformed entry is skipped, never fatal to the tick.
    }
  }
  last.set(watchId, map);
  initializedWallets.add(watchId);
  return map;
}

function persistProgress(watchId: string, balances: Map<string, bigint>, blockHeight?: number): void {
  const record: Record<string, string> = {};
  for (const [tokenId, raw] of balances) {
    if (raw > 0n) record[tokenId] = raw.toString();
  }
  store.saveWatchProgress(watchId, {
    balances: record,
    blockHeight,
    updatedAt: new Date().toISOString(),
  });
}

/** Test hook: drop the in memory snapshots so the next tick hydrates from the store, as a restart would. */
export function __resetWatcherState(): void {
  last = new Map();
  initializedWallets = new Set();
}

function short(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
}

/** One token balance change in a tick, as fed to the alert composer. */
export interface TraderAlertDiff {
  token: TradedToken;
  side: "buy" | "sell";
  amountTokens: number;
  /** balance before the change, when known (watcher events carry it) */
  beforeTokens?: number;
}

/** Alert amounts: two decimals with thousands separators, e.g. 2,889.42. */
export function fmtAlertAmount(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The diffs an alert actually talks about, after the wNEAR rule: if
 * any other token moved in the same tick, every wNEAR diff is dropped,
 * because it is the payment rail of that trade (the wrap in, the
 * payment out) and reads as noise that cancels itself out. If wNEAR
 * is the only token that moved, its diff is a real event on its own
 * and is kept. The alert text and the alert buttons both read from
 * this same set, so the buttons always match the words. Pure.
 */
export function shownDiffs(diffs: TraderAlertDiff[], wnearId: string): TraderAlertDiff[] {
  if (diffs.length === 0) return [];
  const wnear = wnearId.toLowerCase();
  const hasOtherToken = diffs.some((d) => d.token.id.toLowerCase() !== wnear);
  return hasOtherToken ? diffs.filter((d) => d.token.id.toLowerCase() !== wnear) : diffs;
}

/**
 * Compose ONE trader alert from every balance diff a watched account
 * produced in a single tick. Sells are stated before buys; several
 * tokens on one side list with commas and "and" before the last.
 *
 * Pure and exported for tests. Returns undefined when there is nothing
 * to say.
 */
export function composeTraderAlert(
  accountLabel: string,
  diffs: TraderAlertDiff[],
  wnearId: string,
): string | undefined {
  const shown = shownDiffs(diffs, wnearId);
  if (shown.length === 0) return undefined;

  const leg = (d: TraderAlertDiff) => `${fmtAlertAmount(d.amountTokens)} ${d.token.symbol}`;
  const parts: string[] = [];
  const sells = shown.filter((d) => d.side === "sell");
  const buys = shown.filter((d) => d.side === "buy");
  if (sells.length > 0) parts.push(`sold ${joinList(sells.map(leg))}`);
  if (buys.length > 0) parts.push(`bought ${joinList(buys.map(leg))}`);
  if (parts.length === 0) return undefined;
  return `Trader alert: ${accountLabel} ${parts.join(" and ")}.`;
}

/** At most this many Buy buttons ride on one alert. */
export const MAX_ALERT_BUY_BUTTONS = 3;

/** At most this many action buttons (Buy and Sell rows together) ride on one alert. */
export const MAX_ALERT_ACTION_BUTTONS = 3;

/**
 * The tokens an alert offers Buy buttons for: the bought side of the
 * shown diffs, deduplicated, in alert order, capped at
 * MAX_ALERT_BUY_BUTTONS. Pure.
 */
export function alertBoughtTokens(
  diffs: TraderAlertDiff[],
  wnearId: string,
): PendingAlertToken[] {
  const seen = new Set<string>();
  const out: PendingAlertToken[] = [];
  for (const d of shownDiffs(diffs, wnearId)) {
    if (d.side !== "buy") continue;
    const key = d.token.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: d.token.id, symbol: d.token.symbol });
    if (out.length >= MAX_ALERT_BUY_BUTTONS) break;
  }
  return out;
}

/** Clamp a fraction into [0, 1]; anything not a finite number reads as a full exit. */
export function clampSellFraction(fraction: number | undefined): number {
  if (fraction == null || !Number.isFinite(fraction)) return 1;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * The fraction of their own holding a trader sold, from the watcher's
 * balance diff: sold amount over the balance before the move, clamped
 * between 0 and 1. When the balance before is unknown the fraction
 * cannot be derived and this returns 1, a full exit, which is also
 * what a Sell tap falls back to. Pure.
 */
export function sellFractionOf(diff: TraderAlertDiff): number {
  const before = diff.beforeTokens;
  if (before == null || !(before > 0)) return 1;
  return clampSellFraction(diff.amountTokens / before);
}

/**
 * Every actionable leg of an alert, in the order the legs appear in
 * the alert text: sells first (as the composer states them), then
 * buys, deduplicated per side and token, capped at
 * MAX_ALERT_ACTION_BUTTONS rows in total. Sell legs carry the
 * fraction of their holding the trader sold. Pure.
 */
export function alertLegs(diffs: TraderAlertDiff[], wnearId: string): PendingAlertLeg[] {
  const shown = shownDiffs(diffs, wnearId);
  const ordered = [
    ...shown.filter((d) => d.side === "sell"),
    ...shown.filter((d) => d.side === "buy"),
  ];
  const seen = new Set<string>();
  const out: PendingAlertLeg[] = [];
  for (const d of ordered) {
    const key = `${d.side}:${d.token.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      d.side === "sell"
        ? { side: "sell", id: d.token.id, symbol: d.token.symbol, sellFraction: sellFractionOf(d) }
        : { side: "buy", id: d.token.id, symbol: d.token.symbol },
    );
    if (out.length >= MAX_ALERT_ACTION_BUTTONS) break;
  }
  return out;
}

/**
 * How much of a token a Sell tap sells, in raw units: the stored
 * fraction of the user's CURRENT balance, floored. A missing or
 * invalid fraction sells the full holding. Zero balance sells zero.
 * Pure, unit tested.
 */
export function alertSellAmountRaw(userBalanceRaw: bigint, sellFraction: number | undefined): bigint {
  if (userBalanceRaw <= 0n) return 0n;
  const fraction = clampSellFraction(sellFraction);
  if (fraction >= 1) return userBalanceRaw;
  if (fraction <= 0) return 0n;
  return BigInt(Math.floor(Number(userBalanceRaw) * fraction));
}

/**
 * The keyboard under a trader alert: one row per leg, a "Buy
 * <SYMBOL>" button for a bought token or a "Sell <SYMBOL>" button
 * for a sold one, then a single "Ignore" row at the bottom. An alert
 * with no legs gets the Ignore row only. Callback data carries only
 * the pending alert's short id (plus the leg index), never a token
 * account id, so it stays far under Telegram's 64 byte callback cap.
 * Pure, unit tested.
 */
export function buildAlertKeyboard(alertId: string, legs: PendingAlertLeg[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  legs.slice(0, MAX_ALERT_ACTION_BUTTONS).forEach((leg, i) => {
    if (leg.side === "sell") kb.text(`Sell ${leg.symbol}`, `alertsell:${alertId}:${i}`).row();
    else kb.text(`Buy ${leg.symbol}`, `alertbuy:${alertId}:${i}`).row();
  });
  kb.text("Ignore", `alertign:${alertId}`);
  return kb;
}

/**
 * NEAR an alert Buy tap spends: the user's configured AI copy per
 * trade size when they have one set, otherwise ALERT_BUY_NEAR
 * (0.1 NEAR by default). MAX_TRADE_NEAR caps both. Pure, unit tested.
 */
export function alertBuyAmountNear(user: { ai?: { perTradeAmount?: number } }): number {
  const aiSize = user.ai?.perTradeAmount;
  const fallback = config.alertBuyNear > 0 ? config.alertBuyNear : 0.1;
  const base = aiSize != null && aiSize > 0 ? aiSize : fallback;
  return Math.min(base, config.maxTradeNear);
}

/**
 * The chain and messaging operations a tick is built from, behind an
 * interface so tests can drive ticks without a chain. The defaults
 * are the real ones.
 */
export interface WatchTickDeps {
  tokenSet: () => Promise<TradedToken[]>;
  scanBalances: (accountId: string, tokens: TradedToken[]) => Promise<Map<string, bigint>>;
  notifyAlertFn: (
    telegramId: number,
    text: string,
    keyboard: InlineKeyboard,
  ) => Promise<SentMessageRef | undefined>;
  notifyFn: (telegramId: number, text: string) => Promise<void>;
  onBuy: (event: WalletTradeEvent) => Promise<void>;
  onSell: (event: WalletTradeEvent) => Promise<void>;
  blockHeight: () => Promise<number>;
}

const defaultWatchTickDeps: WatchTickDeps = {
  tokenSet: watchTokenSet,
  scanBalances: scanWalletBalances,
  notifyAlertFn: notifyAlert,
  notifyFn: notify,
  onBuy: onTraderBuy,
  onSell: onTraderSell,
  blockHeight: rpcBlockHeight,
};

export async function watchTick(deps: WatchTickDeps = defaultWatchTickDeps): Promise<void> {
  const watched = store.allWatched();
  if (watched.length === 0) return;

  // Dedupe: several users may watch the same trader.
  const byAccount = new Map<string, WatchedWallet[]>();
  for (const w of watched) {
    const key = w.accountId.toLowerCase();
    const list = byAccount.get(key) ?? [];
    list.push(w);
    byAccount.set(key, list);
  }
  const tokens = await deps.tokenSet();
  const registry = new Map(tokens.map((t) => [t.id, t]));
  const height = await deps.blockHeight().catch(() => undefined);

  for (const [accountId, watchers] of byAccount) {
    let curr: Map<string, bigint>;
    try {
      curr = await deps.scanBalances(accountId, tokens);
    } catch (err: any) {
      // One bad account never poisons the tick for the others.
      logError("watcher", `balance scan failed for ${accountId}; skipping it this tick`, err);
      continue;
    }

    for (const w of watchers) {
      try {
        await processWatcher(w, curr, registry, height, deps);
      } catch (err: any) {
        logError("watcher", `tick failed for watched ${w.accountId} (owner ${w.ownerTelegramId}); continuing with the others`, err);
      }
    }
  }
}

/** Diff one watched wallet against its snapshot, then alert and copy. Isolated per watcher by the caller. */
async function processWatcher(
  w: WatchedWallet,
  curr: Map<string, bigint>,
  registry: Map<string, TradedToken>,
  height: number | undefined,
  deps: WatchTickDeps,
): Promise<void> {
  const prev = hydrateProgress(w.id);
  if (!prev) {
    // Baseline snapshot, no alerts for past activity. Persisted, so
    // the baseline survives restarts like any other progress.
    last.set(w.id, curr);
    initializedWallets.add(w.id);
    persistProgress(w.id, curr, height);
    return;
  }
  const tokenIds = new Set<string>([...prev.keys(), ...curr.keys()]);

  // Collect every diff for this watcher first. The user gets ONE
  // composed alert per tick, while the copy engine below still
  // consumes the diffs one by one, exactly as before.
  const events: WalletTradeEvent[] = [];
  for (const tokenId of tokenIds) {
    const before = prev.get(tokenId) ?? 0n;
    const after = curr.get(tokenId) ?? 0n;
    if (after === before) continue;
    const token = registry.get(tokenId);
    if (!token) continue;

    const toTokens = (raw: bigint) => Number(raw) / 10 ** token.decimals;
    const side = after > before ? "buy" : "sell";
    events.push({
      wallet: w,
      token,
      side,
      amountTokens: Math.abs(toTokens(after > before ? after - before : before - after)),
      beforeTokens: toTokens(before),
      afterTokens: toTokens(after),
    });
  }

  if (events.length === 0) {
    last.set(w.id, curr);
    return;
  }

  // Persist the new snapshot BEFORE dispatching alerts and copies.
  // If the process dies mid dispatch, the restart resumes from this
  // snapshot and the move is never alerted or copied twice. The cost
  // of a badly timed crash is at most one lost alert; the alternative
  // (persist after dispatch) can double copy a trade, which spends
  // real money twice.
  last.set(w.id, curr);
  persistProgress(w.id, curr, height);

  const text = composeTraderAlert(short(w.accountId), events, config.wnearId);
  if (text) {
    const fullText = text + (w.mode === "auto" ? "\nAuto copy is ON, working on it..." : "");
    // Every watcher gets their own pending alert record and their
    // own buttons; the record is how a later tap finds the tokens
    // and the message to edit, since callback data carries only
    // the short record id.
    const legs = alertLegs(events, config.wnearId);
    const alert: PendingAlert = {
      id: newPendingAlertId(),
      telegramId: w.ownerTelegramId,
      traderAccountId: w.accountId,
      tokens: alertBoughtTokens(events, config.wnearId),
      legs,
      text: fullText,
      createdAt: new Date().toISOString(),
    };
    store.savePendingAlert(alert);
    const sent = await deps.notifyAlertFn(
      w.ownerTelegramId,
      fullText,
      buildAlertKeyboard(alert.id, legs),
    );
    if (sent) {
      alert.chatId = sent.chatId;
      alert.messageId = sent.messageId;
      store.savePendingAlert(alert);
    }
  }

  if (w.mode === "auto") {
    for (const event of events) {
      try {
        if (event.side === "buy") await deps.onBuy(event);
        else await deps.onSell(event);
      } catch (err: any) {
        logError(
          "copy",
          `user=${w.ownerTelegramId} auto copy ${event.side} ${event.token.symbol} from ${w.accountId} failed`,
          err,
        );
        await deps.notifyFn(w.ownerTelegramId, `Auto copy failed: ${err?.message ?? err}`);
      }
    }
  }
}

/**
 * The watcher loop: a self scheduling timer (so ticks never overlap),
 * first tick five seconds after boot for the baseline snapshot. A
 * tick that throws is logged to console and file, and the next tick
 * waits with a modest backoff (doubling, capped at eight times the
 * poll interval) instead of hammering a struggling network; a clean
 * tick resets the backoff.
 */
export function startWatcher(onTick: () => Promise<void>): void {
  const baseMs = config.watchPollSecs * 1000;
  let failures = 0;
  const run = async (): Promise<void> => {
    try {
      await onTick();
      failures = 0;
      setTimeout(run, baseMs);
    } catch (err: any) {
      failures += 1;
      const delayMs = Math.min(baseMs * 2 ** failures, baseMs * 8);
      console.error("watcher tick:", err?.message ?? err);
      logError("watcher", `tick failed (${failures} in a row); next tick in ${Math.round(delayMs / 1000)}s`, err);
      setTimeout(run, delayMs);
    }
  };
  setTimeout(run, 5000); // first tick takes the baseline snapshot
}
