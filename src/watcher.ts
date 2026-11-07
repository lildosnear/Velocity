import { config } from "./config";
import { readFtBalanceRaw } from "./near";
import { type TradedToken, type WatchedWallet } from "./store";
import { store } from "./store";
import { notify } from "./notifier";
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

function short(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
}

/** One token balance change in a tick, as fed to the alert composer. */
export interface TraderAlertDiff {
  token: TradedToken;
  side: "buy" | "sell";
  amountTokens: number;
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
 * Compose ONE trader alert from every balance diff a watched account
 * produced in a single tick. Sells are stated before buys; several
 * tokens on one side list with commas and "and" before the last.
 *
 * The wNEAR rule: if any other token moved in the same tick, every
 * wNEAR diff is dropped from the text, because it is the payment rail
 * of that trade (the wrap in, the payment out) and reads as noise that
 * cancels itself out. If wNEAR is the only token that moved, its diff
 * is a real event on its own and is kept.
 *
 * Pure and exported for tests. Returns undefined when there is nothing
 * to say.
 */
export function composeTraderAlert(
  accountLabel: string,
  diffs: TraderAlertDiff[],
  wnearId: string,
): string | undefined {
  if (diffs.length === 0) return undefined;
  const wnear = wnearId.toLowerCase();
  const hasOtherToken = diffs.some((d) => d.token.id.toLowerCase() !== wnear);
  const shown = hasOtherToken ? diffs.filter((d) => d.token.id.toLowerCase() !== wnear) : diffs;
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

export async function watchTick(): Promise<void> {
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
  const tokens = await watchTokenSet();
  const registry = new Map(tokens.map((t) => [t.id, t]));

  for (const [accountId, watchers] of byAccount) {
    let curr: Map<string, bigint>;
    try {
      curr = await scanWalletBalances(accountId, tokens);
    } catch {
      continue;
    }

    for (const w of watchers) {
      if (!initializedWallets.has(w.id)) {
        last.set(w.id, curr);
        initializedWallets.add(w.id);
        continue; // baseline snapshot, no alerts for past activity
      }
      const prev = last.get(w.id) ?? new Map<string, bigint>();
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

      if (events.length > 0) {
        const text = composeTraderAlert(short(w.accountId), events, config.wnearId);
        if (text) {
          await notify(
            w.ownerTelegramId,
            text + (w.mode === "auto" ? "\nAuto copy is ON, working on it..." : ""),
          );
        }

        if (w.mode === "auto") {
          for (const event of events) {
            try {
              if (event.side === "buy") await onTraderBuy(event);
              else await onTraderSell(event);
            } catch (err: any) {
              await notify(w.ownerTelegramId, `Auto copy failed: ${err?.message ?? err}`);
            }
          }
        }
      }
      last.set(w.id, curr);
    }
  }
}

export function startWatcher(onTick: () => Promise<void>): void {
  const secs = config.watchPollSecs;
  const run = () => onTick().catch((err) => console.error("watcher tick:", err?.message ?? err));
  setInterval(run, secs * 1000);
  setTimeout(run, 5000); // first tick takes the baseline snapshot
}
