import { KeyPair } from "near-api-js";
import { config } from "./config";
import { decryptPrivateKey, type EncryptedKey } from "./crypto";
import { store, type UserRecord } from "./store";
import {
  accountExists,
  callFunction,
  ensureFtStorage,
  readFtBalanceRaw,
  readNearBalanceYocto,
  transferFt,
  transferNear,
  type WalletCreds,
} from "./near";

/**
 * Named wallets. Every user starts with an implicit hex wallet: free,
 * instant, and the engine underneath forever. On top of that the bot
 * can create a named account (NAME.testnet here, NAME.near on mainnet)
 * through the network registrar, with the SAME public key as the hex
 * wallet, so the one encrypted secret the bot already holds controls
 * both. Once created, the named account becomes the user's primary
 * account everywhere in the bot; the hex wallet stays on the record as
 * legacyAccountId and keeps anything the sweep could not move.
 *
 * Registrar behaviour, verified live on testnet on 2026-11-07:
 * - Any funded account may call create_account on the registrar
 *   ("testnet" here, "near" on mainnet); there is no whitelist.
 * - The attached deposit becomes the new account's starting balance in
 *   full. The testnet registrar charges nothing at creation (even a
 *   zero deposit lands). The default deposit is 0.01 NEAR anyway,
 *   because a fresh account holding only 0.002 could not send a plain
 *   transfer: the node costed the operation at 0.00810744245625 NEAR
 *   of worst case gas prepayment (mostly refunded) and rejected it
 *   with NotEnoughBalance. At 0.01 the account sends immediately.
 * - Short labels are fine (a 3 character label was created live);
 *   taken names fail on chain with AccountAlreadyExists.
 *
 * Creation is signed by a funded creator account configured in the
 * environment (CREATOR_ACCOUNT_ID and CREATOR_SECRET_ENC, see
 * scripts/make-creator-wallet). With no creator configured, named
 * wallets stay dormant: /start behaves exactly as before and /name
 * explains names are not enabled yet. The AI wallet is never named.
 */

/** Shortest label the bot will attempt. NEAR ids need at least 2 characters overall; 3 character labels are proven creatable on the testnet registrar. */
export const MIN_LABEL_LENGTH = 2;

/** Longest label: the full account id (label plus suffix) must fit NEAR's 64 character limit. */
export function maxLabelLength(): number {
  return 64 - config.nameSuffix.length;
}

/**
 * Turn a Telegram username (or any typed string) into a tidy NEAR name
 * label: lowercase, every run of characters NEAR cannot use (including
 * underscores, dots and spaces) collapses into a single dash, and no
 * leading, trailing or doubled separators survive. Returns undefined
 * when nothing usable remains or the result is out of length bounds.
 * Pure, unit tested.
 */
export function sanitizeLabel(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const label = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (label.length < MIN_LABEL_LENGTH || label.length > maxLabelLength()) return undefined;
  return label;
}

/** True for implicit account ids (64 hex characters). */
export function isImplicitId(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId);
}

export function fullNameId(label: string): string {
  return `${label}${config.nameSuffix}`;
}

/** The label the bot would try for this user, derived from their Telegram username. */
export function candidateLabelFor(user: UserRecord): string | undefined {
  return sanitizeLabel(user.username);
}

export interface CreatorWallet {
  accountId: string;
  secret?: string;
}

/** The configured creator account, mirroring the fee wallet pattern. Undefined when names are not enabled. */
export function getCreatorWallet(): CreatorWallet | undefined {
  if (!config.creatorAccountId) return undefined;
  let secret: string | undefined;
  if (config.creatorSecretEnc) {
    try {
      secret = decryptPrivateKey(JSON.parse(config.creatorSecretEnc) as EncryptedKey);
    } catch {
      console.error("CREATOR_SECRET_ENC could not be decrypted, named wallets disabled.");
    }
  }
  return { accountId: config.creatorAccountId, secret };
}

export function namesEnabled(): boolean {
  const creator = getCreatorWallet();
  return Boolean(creator?.secret);
}

function publicKeyOfSecret(secret: string): string {
  return KeyPair.fromString(secret as any).getPublicKey().toString();
}

function fmtAmount(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "");
}

export interface NameAttemptResult {
  state: "created" | "unavailable" | "failed" | "disabled" | "invalid" | "none";
  /** the full named account id, when created (or already primary) */
  namedId?: string;
  reason?: string;
  /** NEAR moved from the legacy wallet to the named account during the sweep */
  sweptNear?: number;
  /** human lines describing exactly what is still on the legacy address */
  leftovers?: string[];
  txids?: string[];
}

/**
 * Gas attached to the sweep's token calls, deliberately lean. The node
 * makes the sender prepay the full attached gas at the current gas
 * price (the unused part is refunded), so the usual 100 TGas function
 * call needs roughly 0.1 NEAR of momentary headroom at the testnet gas
 * price measured on 2026-11-07, more than a modest wallet holds. A
 * storage deposit or an ft_transfer actually burns a few TGas; 10 and
 * 15 TGas are ample and cut the headroom to roughly 0.01 to 0.016.
 */
const SWEEP_STORAGE_GAS = 10_000_000_000_000n;
const SWEEP_TRANSFER_GAS = 15_000_000_000_000n;

/**
 * Move whatever a legacy hex wallet holds to the named account: every
 * recorded token balance first (paying each token's storage deposit
 * for the named account out of the legacy balance, with the lean gas
 * above), then the NEAR, keeping a 0.003 NEAR reserve behind for the
 * legacy account's own gas. Best effort: failures are reported line
 * by line, never hidden, and the legacy id stays on the user record
 * either way.
 */
export async function sweepLegacyFunds(
  user: UserRecord,
  legacyId: string,
  namedId: string,
  secret: string,
): Promise<{ sweptNear: number; leftovers: string[]; txids: string[] }> {
  const leftovers: string[] = [];
  const txids: string[] = [];
  let sweptNear = 0;
  if (legacyId === namedId) return { sweptNear, leftovers, txids };
  if (!(await accountExists(legacyId).catch(() => false))) return { sweptNear, leftovers, txids };
  const legacyCreds: WalletCreds = { accountId: legacyId, secret };

  const tokens = new Map<string, { symbol: string; decimals: number }>();
  for (const t of Object.values(user.tokens ?? {})) tokens.set(t.id, { symbol: t.symbol, decimals: t.decimals });
  for (const c of config.payCurrencies) {
    if (c.kind === "ft" && c.contractId && !tokens.has(c.contractId)) {
      tokens.set(c.contractId, { symbol: c.symbol, decimals: c.decimals });
    }
  }
  for (const [tokenId, meta] of tokens) {
    try {
      const raw = await readFtBalanceRaw(tokenId, legacyId);
      if (raw <= 0n) continue;
      await ensureFtStorage(legacyCreds, tokenId, namedId, SWEEP_STORAGE_GAS);
      txids.push(await transferFt(legacyCreds, tokenId, namedId, raw, undefined, SWEEP_TRANSFER_GAS));
    } catch (err: any) {
      try {
        const raw = await readFtBalanceRaw(tokenId, legacyId);
        const amount = Number(raw) / 10 ** meta.decimals;
        leftovers.push(`${fmtAmount(amount)} ${meta.symbol} is still on your old address ${legacyId}`);
      } catch {
        leftovers.push(`some ${meta.symbol} could not be moved and is still on your old address ${legacyId}`);
      }
      console.error(`name sweep: moving ${tokenId} for user ${user.telegramId} failed: ${err?.message ?? err}`);
    }
  }

  try {
    const balance = await readNearBalanceYocto(legacyId);
    const reserve = 3n * 10n ** 21n; // 0.003 NEAR stays behind for the old account's own gas
    if (balance > reserve) {
      const amount = balance - reserve;
      txids.push(await transferNear(legacyCreds, namedId, amount));
      sweptNear = Number(amount) / 1e24;
    }
  } catch (err: any) {
    console.error(`name sweep: moving NEAR for user ${user.telegramId} failed: ${err?.message ?? err}`);
  }
  try {
    const remaining = await readNearBalanceYocto(legacyId);
    if (remaining > 10n ** 20n) {
      leftovers.push(`${fmtAmount(Number(remaining) / 1e24)} NEAR is still on your old address ${legacyId}`);
    }
  } catch {
    // A failed re-read hides nothing: the legacy id stays on the record.
  }
  return { sweptNear, leftovers, txids };
}

/**
 * Create the named account for a user from a label and make it
 * primary. Records the outcome on the user record at every terminal
 * state so callers (and later commands) can see exactly what happened.
 * Never throws for chain or validation problems: creation trouble must
 * not break the command that triggered it.
 */
export async function createNamedAccountFor(user: UserRecord, label: string): Promise<NameAttemptResult> {
  const namedId = fullNameId(label);
  if (user.accountId === namedId) {
    return { state: "created", namedId };
  }
  if (!isImplicitId(user.accountId)) {
    // Already primary on some other named account; renaming is not offered.
    return { state: "created", namedId: user.accountId };
  }
  const creator = getCreatorWallet();
  if (!creator?.secret) return { state: "disabled", reason: "no creator account is configured" };

  if (label !== sanitizeLabel(label)) {
    user.nameStatus = { state: "failed", candidate: label, reason: "the name is not a valid NEAR name" };
    store.saveUser(user);
    return { state: "invalid", reason: "the name is not a valid NEAR name" };
  }

  if (await accountExists(namedId).catch(() => false)) {
    user.nameStatus = { state: "unavailable", candidate: label, reason: `${namedId} is already taken` };
    store.saveUser(user);
    return { state: "unavailable", reason: `${namedId} is already taken` };
  }

  const secret = decryptPrivateKey(user.encSecret);
  const creatorCreds: WalletCreds = { accountId: creator.accountId, secret: creator.secret };
  let createTx: string;
  try {
    createTx = await callFunction(
      creatorCreds,
      config.registrarId,
      "create_account",
      { new_account_id: namedId, new_public_key: publicKeyOfSecret(secret) },
      config.nameCreationDepositYocto,
    );
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("AccountAlreadyExists") || msg.includes("already exists")) {
      user.nameStatus = { state: "unavailable", candidate: label, reason: `${namedId} is already taken` };
      store.saveUser(user);
      return { state: "unavailable", reason: `${namedId} is already taken` };
    }
    const reason = msg.slice(0, 200);
    user.nameStatus = { state: "failed", candidate: label, reason };
    store.saveUser(user);
    console.error(`named wallet creation for user ${user.telegramId} (${namedId}) failed: ${msg}`);
    return { state: "failed", reason };
  }

  const legacyId = user.accountId;
  user.legacyAccountId = legacyId;
  user.accountId = namedId;
  user.nameStatus = { state: "created", candidate: label };
  store.saveUser(user);

  const sweep = await sweepLegacyFunds(user, legacyId, namedId, secret);
  return {
    state: "created",
    namedId,
    sweptNear: sweep.sweptNear,
    leftovers: sweep.leftovers,
    txids: [createTx, ...sweep.txids],
  };
}

/**
 * The /start path for a brand new user: derive the candidate from the
 * Telegram username and try to create it, recording why not when it
 * cannot happen. Existing users are never attempted here; their one
 * route in is /name, so the registrar is only touched on purpose.
 */
export async function attemptNameForNewUser(user: UserRecord): Promise<NameAttemptResult> {
  if (!namesEnabled()) return { state: "disabled" };
  const candidate = candidateLabelFor(user);
  if (!candidate) {
    user.nameStatus = {
      state: "none",
      reason: user.username
        ? "your Telegram username does not reduce to a usable NEAR name"
        : "you have no Telegram username to derive a name from",
    };
    store.saveUser(user);
    return { state: "none", reason: user.nameStatus.reason };
  }
  return createNamedAccountFor(user, candidate);
}
