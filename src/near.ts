import { connect, KeyPair, keyStores, Account, providers } from "near-api-js";
import { config } from "./config";

/**
 * NEAR chain layer, the Velocity counterpart of Forge src/arch.ts.
 *
 * Wallets are implicit accounts: a fresh ed25519 keypair whose account id
 * is the hex encoding of the public key. The account springs into existence
 * on chain the first time someone sends it NEAR, which is exactly the
 * deposit flow the bot shows the user. Named accounts are supported
 * anywhere an account id is accepted (watching, withdrawing, the fee
 * wallet) because every read and write here goes by account id.
 *
 * Secret keys exist in plain form only inside this process, at signing
 * time. Views go through raw JSON RPC so read paths never need a signer.
 */

export interface WalletCreds {
  accountId: string;
  /** NEAR secret key string ("ed25519:..."), decrypted in memory only */
  secret: string;
}

export interface NewWallet {
  accountId: string;
  publicKey: string;
  secret: string;
}

const GAS_300_TGAS = 300_000_000_000_000n;
const GAS_100_TGAS = 100_000_000_000_000n;
const ONE_YOCTO = 1n;

let keyStore: InstanceType<typeof keyStores.InMemoryKeyStore> | undefined;

function getKeyStore() {
  if (!keyStore) keyStore = new keyStores.InMemoryKeyStore();
  return keyStore;
}

let failoverProvider: InstanceType<typeof providers.FailoverRpcProvider> | undefined;

/**
 * One provider over every configured RPC endpoint. near-api-js rotates
 * to the next endpoint when a call errors, so a rate limited or down
 * provider does not fail signed calls (transfers, swaps) either.
 */
function getProvider() {
  if (!failoverProvider) {
    failoverProvider = new providers.FailoverRpcProvider(
      config.nearRpcUrls.map((url) => new providers.JsonRpcProvider({ url })),
    );
  }
  return failoverProvider;
}

async function nearConnection() {
  return connect({
    networkId: config.network,
    keyStore: getKeyStore(),
    nodeUrl: config.nearRpcUrls[0],
    provider: getProvider(),
  });
}

/** Create a fresh implicit wallet keypair. Nothing touches the chain yet. */
export function createWallet(): NewWallet {
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKeyHex = Buffer.from(keyPair.getPublicKey().data).toString("hex");
  return { accountId: publicKeyHex, publicKey: keyPair.getPublicKey().toString(), secret: keyPair.toString() };
}

/** Implicit account id for a secret key, used to check key and account match. */
export function accountIdForSecret(secret: string): string {
  const kp = KeyPair.fromString(secret as any);
  return Buffer.from(kp.getPublicKey().data).toString("hex");
}

async function signerAccount(creds: WalletCreds): Promise<Account> {
  const kp = KeyPair.fromString(creds.secret as any);
  await getKeyStore().setKey(config.network, creds.accountId, kp);
  const near = await nearConnection();
  return near.account(creds.accountId);
}

function txHash(outcome: any): string {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? "unknown";
}

function assertSuccess(outcome: any, what: string): void {
  const status = outcome?.status ?? outcome?.final_execution_status;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(`${what} failed on chain: ${JSON.stringify(status.Failure).slice(0, 300)}`);
  }
  // near-api-js throws on failure in most paths; this is a belt and braces check.
  const receipts: any[] = outcome?.receipts_outcome ?? [];
  for (const r of receipts) {
    const s = r?.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) {
      throw new Error(`${what} failed on chain: ${JSON.stringify(s.Failure).slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Raw JSON RPC views (no signer needed)
// ---------------------------------------------------------------------------

interface RpcResult<T> {
  result?: T;
  error?: any;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RpcError = Error & { retryable?: boolean };

function rpcError(message: string, retryable: boolean): RpcError {
  const err = new Error(message) as RpcError;
  err.retryable = retryable;
  return err;
}

/**
 * One JSON RPC attempt against one endpoint. Retryable failures (HTTP
 * 429, HTTP 5xx, network errors, and JSON RPC error code -429, the
 * deprecation rejection the legacy endpoint serves) are flagged so the
 * caller can rotate; deterministic errors (a missing account, a missing
 * method) throw with the same messages callers have always matched on.
 */
async function rpcAttempt<T>(url: string, method: string, params: any): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "velocity", method, params }),
    });
  } catch (err: any) {
    throw rpcError(`NEAR RPC ${method} network error: ${err?.message ?? err}`, true);
  }
  if (!res.ok) {
    throw rpcError(`NEAR RPC ${method} returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  }
  let json: RpcResult<T>;
  try {
    json = (await res.json()) as RpcResult<T>;
  } catch (err: any) {
    throw rpcError(`NEAR RPC ${method} returned an unreadable response: ${err?.message ?? err}`, true);
  }
  if (json.error) {
    const code = Number((json.error as any)?.code);
    throw rpcError(
      `NEAR RPC ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`,
      code === -429 || code === 429,
    );
  }
  return json.result as T;
}

export interface RpcCaller {
  readonly urls: string[];
  call<T>(method: string, params: any): Promise<T>;
}

/**
 * A JSON RPC caller over an ordered endpoint list. A retryable failure
 * rotates to the next endpoint after a short backoff; whichever
 * endpoint answers becomes the preferred one for the next call, so a
 * rate limited provider is not retried head on for every request.
 */
export function createRpcCaller(urls: string[]): RpcCaller {
  let preferred = 0;
  return {
    urls,
    async call<T>(method: string, params: any): Promise<T> {
      let lastErr: any;
      for (let attempt = 0; attempt < urls.length; attempt++) {
        const idx = (preferred + attempt) % urls.length;
        try {
          const value = await rpcAttempt<T>(urls[idx], method, params);
          preferred = idx;
          return value;
        } catch (err: any) {
          lastErr = err;
          if (!err?.retryable) throw err;
          if (attempt < urls.length - 1) await sleep(250 * (attempt + 1));
        }
      }
      throw lastErr;
    },
  };
}

const defaultRpcCaller = createRpcCaller(config.nearRpcUrls);

async function rpc<T>(method: string, params: any): Promise<T> {
  return defaultRpcCaller.call<T>(method, params);
}

/**
 * Run an async mapper over items with bounded concurrency, preserving
 * input order in the results. Used to parallelize pool reads and quote
 * calls that used to run one at a time and trip RPC rate limits.
 */
export async function parallelMap<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

export async function rpcBlockHeight(): Promise<number> {
  const status = await rpc<any>("status", []);
  return Number(status?.sync_info?.latest_block_height ?? 0);
}

/** Call a contract view method. Returns the decoded JSON value, or undefined when the account or method does not exist. */
export async function viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T | undefined> {
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
  try {
    const result = await rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64,
    });
    const bytes = Buffer.from(result.result);
    if (bytes.length === 0) return undefined;
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("does not exist") || msg.includes("no contract code") || msg.includes("MethodNotFound") || msg.includes("method not found")) {
      return undefined;
    }
    throw err;
  }
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    return true;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("does not exist") || msg.includes("UNKNOWN_ACCOUNT")) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Balances and token reads
// ---------------------------------------------------------------------------

/** Native NEAR balance in yocto, as bigint. Zero for accounts that do not exist yet. */
export async function readNearBalanceYocto(accountId: string): Promise<bigint> {
  try {
    const acct = await rpc<{ amount: string }>("query", {
      request_type: "view_account",
      finality: "optimistic",
      account_id: accountId,
    });
    return BigInt(acct.amount);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("does not exist") || msg.includes("UNKNOWN_ACCOUNT")) return 0n;
    throw err;
  }
}

export async function readNearBalance(accountId: string): Promise<number> {
  return Number(await readNearBalanceYocto(accountId)) / 1e24;
}

export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  decimals: number;
}

const metadataCache = new Map<string, FtMetadata>();

export async function getFtMetadata(contractId: string): Promise<FtMetadata | undefined> {
  const cached = metadataCache.get(contractId);
  if (cached) return cached;
  const meta = await viewFunction<FtMetadata>(contractId, "ft_metadata");
  if (meta) metadataCache.set(contractId, meta);
  return meta;
}

/** Fungible token balance in raw base units. Zero when the holder is not registered or the token does not exist. */
export async function readFtBalanceRaw(contractId: string, accountId: string): Promise<bigint> {
  const bal = await viewFunction<string>(contractId, "ft_balance_of", { account_id: accountId });
  if (bal === undefined || bal === null) return 0n;
  return BigInt(bal);
}

export async function readFtBalance(contractId: string, accountId: string, decimals: number): Promise<number> {
  return Number(await readFtBalanceRaw(contractId, accountId)) / 10 ** decimals;
}

// ---------------------------------------------------------------------------
// Writes (signing)
// ---------------------------------------------------------------------------

export async function transferNear(creds: WalletCreds, toAccountId: string, amountYocto: bigint): Promise<string> {
  if (amountYocto <= 0n) throw new Error("Transfer amount must be positive.");
  const account = await signerAccount(creds);
  const outcome = await account.sendMoney(toAccountId, amountYocto);
  assertSuccess(outcome, "NEAR transfer");
  return txHash(outcome);
}

/**
 * Ensure the holder is registered on a contract that keeps per account
 * state behind a storage deposit (NEP 145 style). Works for fungible
 * token contracts and for the DCL exchange, which holds an internal
 * account per user. Returns a tx hash when a deposit was made.
 */
export async function ensureContractStorage(
  creds: WalletCreds,
  contractId: string,
  fallbackMinYocto: bigint,
  holderId: string = creds.accountId,
): Promise<string | undefined> {
  const existing = await viewFunction<{ total: string } | null>(contractId, "storage_balance_of", { account_id: holderId });
  if (existing && BigInt(existing.total) > 0n) return undefined;
  const bounds = await viewFunction<{ min: string }>(contractId, "storage_balance_bounds", {});
  const min = bounds?.min ? BigInt(bounds.min) : fallbackMinYocto;
  const account = await signerAccount(creds);
  const outcome = await account.functionCall({
    contractId,
    methodName: "storage_deposit",
    args: { account_id: holderId, registration_only: true },
    gas: GAS_100_TGAS,
    attachedDeposit: min,
  });
  assertSuccess(outcome, `storage_deposit on ${contractId}`);
  return txHash(outcome);
}

/** Ensure the holder is registered on a fungible token contract (NEP 145). Returns a tx hash when a deposit was made. */
export async function ensureFtStorage(
  creds: WalletCreds,
  contractId: string,
  holderId: string = creds.accountId,
): Promise<string | undefined> {
  // 0.00125 NEAR, the usual NEP 145 minimum, when the contract does not publish bounds.
  return ensureContractStorage(creds, contractId, 125n * 10n ** 19n, holderId);
}

export async function transferFt(
  creds: WalletCreds,
  contractId: string,
  toAccountId: string,
  amountRaw: bigint,
  memo?: string,
): Promise<string> {
  if (amountRaw <= 0n) throw new Error("Transfer amount must be positive.");
  await ensureFtStorage(creds, contractId, toAccountId);
  const account = await signerAccount(creds);
  const outcome = await account.functionCall({
    contractId,
    methodName: "ft_transfer",
    args: { receiver_id: toAccountId, amount: amountRaw.toString(), memo: memo ?? "Velocity" },
    gas: GAS_100_TGAS,
    attachedDeposit: ONE_YOCTO,
  });
  assertSuccess(outcome, `ft_transfer on ${contractId}`);
  return txHash(outcome);
}

/** Wrap native NEAR into wNEAR (near_deposit on the wrap contract). */
export async function wrapNear(creds: WalletCreds, amountYocto: bigint): Promise<string> {
  await ensureFtStorage(creds, config.wnearId);
  const account = await signerAccount(creds);
  const outcome = await account.functionCall({
    contractId: config.wnearId,
    methodName: "near_deposit",
    args: {},
    gas: GAS_100_TGAS,
    attachedDeposit: amountYocto,
  });
  assertSuccess(outcome, "near_deposit (wrap)");
  return txHash(outcome);
}

/** Unwrap wNEAR back into native NEAR (near_withdraw on the wrap contract). */
export async function unwrapNear(creds: WalletCreds, amountYocto: bigint): Promise<string> {
  const account = await signerAccount(creds);
  const outcome = await account.functionCall({
    contractId: config.wnearId,
    methodName: "near_withdraw",
    args: { amount: amountYocto.toString() },
    gas: GAS_100_TGAS,
    attachedDeposit: ONE_YOCTO,
  });
  assertSuccess(outcome, "near_withdraw (unwrap)");
  return txHash(outcome);
}

/** Generic function call used by the Ref instant swap path. */
export async function callFunction(
  creds: WalletCreds,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  attachedDepositYocto: bigint,
  gas: bigint = GAS_300_TGAS,
): Promise<string> {
  const account = await signerAccount(creds);
  const outcome = await account.functionCall({
    contractId,
    methodName,
    args,
    gas,
    attachedDeposit: attachedDepositYocto,
  });
  assertSuccess(outcome, `${methodName} on ${contractId}`);
  return txHash(outcome);
}

export const GAS = { T100: GAS_100_TGAS, T300: GAS_300_TGAS, ONE_YOCTO };
