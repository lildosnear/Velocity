import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { config } from "./config";
import { decryptPrivateKey, type EncryptedKey } from "./crypto";
import { logError } from "./log";

/**
 * Store: a single JSON file, same shape as the Forge store.
 * Secret keys are stored ONLY in encrypted form (see crypto.ts).
 * Nothing here ever logs a key.
 * Token holdings are read live on chain, so unlike Forge there are no
 * paper balances: the store keeps the list of tokens each user has traded
 * so balances and positions can be enumerated.
 *
 * Durability (the 2026-11-07 hardening pass). This file holds every
 * user's encrypted secret key, so losing it orphans every wallet the
 * bot ever made. Saves are therefore atomic: the new state is written
 * to a temp file in the same directory, fsynced, and renamed over the
 * store, so a crash or a power cut mid save leaves either the old
 * file or the new one, never a torn half file. Before each replace,
 * the previous store is copied to a timestamped backup and the last
 * five are kept. On load, a missing or unparseable main store falls
 * back to the newest parseable backup and says so loudly; if nothing
 * parses, loading throws a clear operator error rather than starting
 * empty and orphaning every wallet.
 */

export interface TradedToken {
  /** fungible token contract account id */
  id: string;
  symbol: string;
  decimals: number;
}

/**
 * Where a user's named wallet stands: the outcome of the last name the
 * USER asked for. Names are only ever the ones a user typed (at the
 * /start prompt, the /name prompt, or /name <name>); the bot never
 * derives a name from anything. "none" means no attempt has been made
 * yet. "unavailable" means the asked for name is taken on chain.
 * "failed" keeps the chain or validation reason for the last attempt.
 */
export interface NameStatus {
  state: "none" | "created" | "unavailable" | "failed";
  /** the label that was attempted or created, without the network suffix */
  candidate?: string;
  reason?: string;
}

export interface UserRecord {
  telegramId: number;
  /** NEAR account id of the hot wallet (implicit hex id, or a named account) */
  accountId: string;
  /** the original implicit hex wallet, kept when a named account took over as primary */
  legacyAccountId?: string;
  nameStatus?: NameStatus;
  /**
   * True while the bot is waiting for this user to reply with the
   * wallet name they want (set by /start for brand new users and by
   * /name with no argument). While set, the router treats the user's
   * next plain text message as the name; any command, or the reply
   * "skip", clears it. It has no expiry: it simply waits.
   */
  pendingNamePrompt?: boolean;
  /** encrypted NEAR secret key ("ed25519:...") */
  encSecret: EncryptedKey;
  /** which currency the user pays with: "NEAR", "USDC" or "USDT" */
  payCurrency: string;
  /** tokens this user has traded, by contract id */
  tokens: Record<string, TradedToken>;
  /** telegramId of the referrer, set once when a new user joins via a referral link */
  referredBy?: number;
  /** how many of this user's manual trades counted toward the referral program */
  refTradeCount?: number;
  /** NEAR earned as a referrer, withdrawable via /ref withdraw */
  referralEarnedNear?: number;
  ai?: AiConfig;
  createdAt: string;
}

export interface TradeRecord {
  at: string;
  telegramId: number;
  side: "buy" | "sell";
  /** token contract account id */
  tokenId: string;
  symbol: string;
  /** total paid (buy) or received (sell), in the pay currency, human units */
  payAmount: number;
  payCurrency: string;
  /** the same trade valued in NEAR at the trade price (reporting and PnL basis) */
  nearValue: number;
  tokenAmount: number;
  /** price in NEAR per token */
  priceNear: number;
  /** bot fee actually charged on this trade, in NEAR value terms */
  feeNear: number;
  /** which pool kind filled the trade, when a pool filled it */
  poolKind?: "simple" | "dcl";
  viaAi?: boolean;
  txids: string[];
}

export interface PendingSettlement {
  at: string;
  telegramId: number;
  description: string;
  txids: string[];
}

export interface PendingAlertToken {
  /** fungible token contract account id */
  id: string;
  symbol: string;
}

/**
 * One actionable leg of a trader alert: a token the trader bought or
 * sold, in the order the legs appear in the alert text. Sell legs
 * carry the fraction of their own holding the trader sold, derived
 * from the watcher's balance diff at alert time, so a Sell tap can
 * mirror the same fraction of the receiving user's holding.
 */
export interface PendingAlertLeg {
  side: "buy" | "sell";
  /** fungible token contract account id */
  id: string;
  symbol: string;
  /**
   * Sell legs only: the fraction of the trader's holding they sold,
   * between 0 and 1. Undefined when the fraction could not be derived,
   * which a Sell tap treats as selling the user's full holding.
   */
  sellFraction?: number;
}

/**
 * One trader alert that carries Buy, Sell and Ignore buttons, kept so
 * a button tap can be resolved without putting token account ids in
 * the callback data (Telegram caps callback data at 64 bytes and NEAR
 * ids can be long). The record is per receiving user: every watcher
 * gets their own alert message, their own record and their own
 * buttons, and one user acting on theirs never touches another user's
 * copy. Records expire one hour after the alert was sent. Records
 * written before legs existed carry no legs and are treated as
 * expired by the tap handlers.
 */
export interface PendingAlert {
  /** short random id, the only thing the callback data carries */
  id: string;
  /** the user this alert was sent to; only they may use its buttons */
  telegramId: number;
  /** NEAR account id of the trader whose move triggered the alert */
  traderAccountId: string;
  /** tokens the trader bought in this alert, in alert order (button order) */
  tokens: PendingAlertToken[];
  /** every actionable leg of the alert (buys and sells), in alert order */
  legs?: PendingAlertLeg[];
  /** the full alert text as sent, so taps can append a line to it */
  text: string;
  /** where the alert message lives, filled in once Telegram confirms the send */
  chatId?: number;
  messageId?: number;
  createdAt: string;
}

/** Pending alerts live for one hour after the alert is sent. */
export const PENDING_ALERT_TTL_MS = 60 * 60 * 1000;

/** Short random id for callback data: 10 hex chars keeps callbacks far under the 64 byte cap. */
export function newPendingAlertId(): string {
  return randomBytes(5).toString("hex");
}

export function pendingAlertExpired(alert: PendingAlert, now = Date.now()): boolean {
  const created = Date.parse(alert.createdAt);
  return !Number.isFinite(created) || now - created >= PENDING_ALERT_TTL_MS;
}

/** Drop every record at or past the TTL. Pure, unit tested. */
export function prunePendingAlerts(
  alerts: Record<string, PendingAlert>,
  now = Date.now(),
): Record<string, PendingAlert> {
  const out: Record<string, PendingAlert> = {};
  for (const [id, alert] of Object.entries(alerts)) {
    if (!pendingAlertExpired(alert, now)) out[id] = alert;
  }
  return out;
}

export interface WatchedWallet {
  id: string;
  ownerTelegramId: number;
  /** NEAR account id being watched */
  accountId: string;
  mode: "notify" | "auto";
  createdAt: string;
}

export interface CopyPosition {
  tokenId: string;
  symbol: string;
  amount: number;
  entryPriceNear: number;
  /** pay currency the position was opened in, sells pay out in the same currency */
  payCurrency: string;
  watchedWalletId: string;
  openedAt: string;
}

export interface AiConfig {
  enabled: boolean;
  /** NEAR account id of the separate AI wallet */
  accountId: string;
  encSecret: EncryptedKey;
  /** per trade size, denominated in the user's current pay currency */
  perTradeAmount: number;
  /** daily loss limit in NEAR, AI pauses when hit */
  dailyLossLimitNear?: number;
  /** optional stop loss, e.g. 0.6 = close at 60 percent down */
  stopLossPct?: number;
  /** ISO timestamp until which auto mode is paused (daily limit hit) */
  pausedUntil?: string;
  positions: CopyPosition[];
  dailyPnl: { date: string; realizedNear: number };
}

/**
 * The watcher's persisted progress for one watched wallet: the balance
 * snapshot the last completed tick diffed against, so a restart or a
 * crash resumes diffing instead of starting over (and can never
 * re-alert or re-copy a move it already handled). Raw balances are
 * decimal strings because JSON cannot hold bigints. Bounded by the
 * watch token set, which is itself capped.
 */
export interface WatchProgress {
  /** token id -> raw balance (decimal string), nonzero balances only */
  balances: Record<string, string>;
  /** block height when the snapshot was taken, when the tick could read it */
  blockHeight?: number;
  updatedAt: string;
}

interface StoreShape {
  users: Record<string, UserRecord>;
  trades: TradeRecord[];
  pendingSettlements: PendingSettlement[];
  watched: Record<string, WatchedWallet>;
  pendingAlerts: Record<string, PendingAlert>;
  watchProgress: Record<string, WatchProgress>;
}

const storePath = join(config.dataDir, "store.json");
const BACKUP_PREFIX = "store.backup-";
const BACKUP_SUFFIX = ".json";
/** How many timestamped store backups are kept in the data directory. */
export const STORE_BACKUPS_KEPT = 5;

function emptyShape(): StoreShape {
  return { users: {}, trades: [], pendingSettlements: [], watched: {}, pendingAlerts: {}, watchProgress: {} };
}

function normalizeShape(parsed: Partial<StoreShape>): StoreShape {
  return {
    users: parsed.users ?? {},
    trades: parsed.trades ?? [],
    pendingSettlements: parsed.pendingSettlements ?? [],
    watched: parsed.watched ?? {},
    pendingAlerts: parsed.pendingAlerts ?? {},
    watchProgress: parsed.watchProgress ?? {},
  };
}

function readShapeFile(path: string): StoreShape | undefined {
  try {
    return normalizeShape(JSON.parse(readFileSync(path, "utf8")) as Partial<StoreShape>);
  } catch {
    return undefined;
  }
}

/** Backup file paths in the data directory, newest first (the timestamped names sort chronologically). */
export function listStoreBackups(): string[] {
  try {
    return readdirSync(config.dataDir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .sort()
      .reverse()
      .map((f) => join(config.dataDir, f));
  } catch {
    return [];
  }
}

let fallbackNoticeLogged = false;

function load(): StoreShape {
  const mainExists = existsSync(storePath);
  if (mainExists) {
    const main = readShapeFile(storePath);
    if (main) return main;
  }
  const backups = listStoreBackups();
  for (const backup of backups) {
    const shape = readShapeFile(backup);
    if (shape) {
      if (!fallbackNoticeLogged) {
        fallbackNoticeLogged = true;
        const msg =
          `store.json was ${mainExists ? "unreadable" : "missing"}; loaded the newest readable backup ` +
          `(${basename(backup)}). Anything saved after that backup is rolled back.`;
        console.error(`STORE WARNING: ${msg}`);
        logError("store", msg);
      }
      return shape;
    }
  }
  if (!mainExists && backups.length === 0) return emptyShape();
  throw new Error(
    "Velocity store could not be loaded: store.json is unreadable and no readable backup exists in the data folder. " +
      "Refusing to start with an empty store, because that would orphan every user's wallet. " +
      "Restore store.json from a backup copy, then restart.",
  );
}

/** Copy the current store to a timestamped backup (only when it still parses) and prune to the newest few. */
function backupCurrentStore(): void {
  try {
    if (!existsSync(storePath)) return;
    const text = readFileSync(storePath, "utf8");
    JSON.parse(text); // never back up a file that is already broken
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(storePath, join(config.dataDir, `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`));
    for (const stale of listStoreBackups().slice(STORE_BACKUPS_KEPT)) {
      try {
        unlinkSync(stale);
      } catch {
        // Pruning is best effort.
      }
    }
  } catch {
    // A failed backup never blocks the save it precedes.
  }
}

function save(shape: StoreShape): void {
  mkdirSync(config.dataDir, { recursive: true });
  backupCurrentStore();
  // Atomic replace: temp file in the same directory, fsync, rename.
  // A crash or power cut leaves the old store or the new one, whole.
  const tmpPath = join(config.dataDir, `store.json.tmp-${process.pid}`);
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, JSON.stringify(shape, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, storePath);
}

/**
 * Store health for the doctor script and the boot checks. Never
 * throws: a store that cannot be resolved reports parses=false.
 */
export interface StoreInspection {
  path: string;
  exists: boolean;
  /** the main store file itself parses */
  parses: boolean;
  /** users visible through the normal load path (backup fallback included) */
  userCount: number;
  backupCount: number;
}

export function inspectStore(): StoreInspection {
  const exists = existsSync(storePath);
  const parses = exists ? readShapeFile(storePath) !== undefined : false;
  let userCount = 0;
  try {
    userCount = Object.keys(load().users).length;
  } catch {
    userCount = 0;
  }
  return { path: storePath, exists, parses, userCount, backupCount: listStoreBackups().length };
}

/**
 * Master key sanity: when users exist, one stored secret must decrypt
 * under the configured MASTER_KEY. A lost or changed master key makes
 * every wallet in the store unusable, so this is checked at startup
 * and by the doctor instead of surfacing as a cryptic failure inside
 * somebody's trade.
 */
export function verifyStoredSecrets(): { ok: boolean; userCount: number; detail?: string } {
  let shape: StoreShape;
  try {
    shape = load();
  } catch (err: any) {
    return { ok: false, userCount: 0, detail: String(err?.message ?? err) };
  }
  const users = Object.values(shape.users);
  if (users.length === 0) return { ok: true, userCount: 0 };
  try {
    decryptPrivateKey(users[0].encSecret);
    return { ok: true, userCount: users.length };
  } catch (err: any) {
    return {
      ok: false,
      userCount: users.length,
      detail: `decrypting a stored wallet secret failed (${String(err?.message ?? err).slice(0, 120)})`,
    };
  }
}

export const store = {
  getUser(telegramId: number): UserRecord | undefined {
    return load().users[String(telegramId)];
  },
  saveUser(user: UserRecord): void {
    const shape = load();
    shape.users[String(user.telegramId)] = user;
    save(shape);
  },
  logTrade(trade: TradeRecord): void {
    const shape = load();
    shape.trades.push(trade);
    save(shape);
  },
  logPending(p: PendingSettlement): void {
    const shape = load();
    shape.pendingSettlements.push(p);
    save(shape);
  },
  watch(w: WatchedWallet): void {
    const shape = load();
    shape.watched[w.id] = w;
    save(shape);
  },
  unwatch(id: string): void {
    const shape = load();
    delete shape.watched[id];
    delete shape.watchProgress[id];
    save(shape);
  },
  /** The watcher's persisted progress for one watched wallet, if a tick has completed for it. */
  getWatchProgress(watchId: string): WatchProgress | undefined {
    return load().watchProgress[watchId];
  },
  saveWatchProgress(watchId: string, progress: WatchProgress): void {
    const shape = load();
    shape.watchProgress[watchId] = progress;
    save(shape);
  },
  listWatched(ownerTelegramId: number): WatchedWallet[] {
    return Object.values(load().watched).filter((w) => w.ownerTelegramId === ownerTelegramId);
  },
  allWatched(): WatchedWallet[] {
    return Object.values(load().watched);
  },
  allUsers(): UserRecord[] {
    return Object.values(load().users);
  },
  recentTrades(telegramId: number, n = 5): TradeRecord[] {
    return load()
      .trades.filter((t) => t.telegramId === telegramId)
      .slice(-n)
      .reverse();
  },
  /** Full trade history for a user, used for cost basis and PnL math. */
  userTrades(telegramId: number): TradeRecord[] {
    return load().trades.filter((t) => t.telegramId === telegramId);
  },
  /** Save a pending alert. Every write first prunes records past the one hour TTL. */
  savePendingAlert(alert: PendingAlert): void {
    const shape = load();
    shape.pendingAlerts = prunePendingAlerts(shape.pendingAlerts);
    shape.pendingAlerts[alert.id] = alert;
    save(shape);
  },
  getPendingAlert(id: string): PendingAlert | undefined {
    return load().pendingAlerts[id];
  },
  deletePendingAlert(id: string): void {
    const shape = load();
    if (shape.pendingAlerts[id]) {
      delete shape.pendingAlerts[id];
      save(shape);
    }
  },
};

/** Every token worth watching or pricing: configured tokens plus anything any user has traded. */
export function tokenRegistry(): TradedToken[] {
  const byId = new Map<string, TradedToken>();
  for (const t of config.knownTokens) byId.set(t.id, { id: t.id, symbol: t.symbol, decimals: t.decimals });
  for (const u of store.allUsers()) {
    for (const t of Object.values(u.tokens ?? {})) byId.set(t.id, t);
  }
  byId.set(config.wnearId, { id: config.wnearId, symbol: "wNEAR", decimals: 24 });
  return [...byId.values()];
}
