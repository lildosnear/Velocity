import { InMemorySigner, KeyPair, keyStores, providers, transactions, utils } from "near-api-js";
import { config } from "./config";
import { logError, logWarn } from "./log";
import { setChainReady } from "./readiness";

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
 *
 * Hostile network design (the 2026-11-07 hardening pass). Public RPC
 * endpoints rate limit, deprecate, lag and hang, and this layer is
 * built for exactly that:
 * - Every RPC call, read or signed, is bounded by a timeout
 *   (RPC_TIMEOUT_MS, default 20 seconds). Nothing hangs forever.
 * - Reads rotate across the endpoint list on retryable failures, and
 *   each endpoint carries health memory: repeated failures cool an
 *   endpoint down for a few minutes so it is skipped while others are
 *   healthy, then it rejoins on its own.
 * - Signed calls do NOT use the library failover provider (its
 *   internal retries are what produced multi minute hangs and the raw
 *   "Exceeded N providers" errors in live use). Each attempt here
 *   runs against ONE endpoint with the library's own retries off: the
 *   access key nonce and block hash are re-read on that endpoint, the
 *   transaction is signed locally (so its hash is known before it is
 *   broadcast), and only then is it sent. A provider class failure
 *   abandons the attempt and rotates; a nonce failure refetches and
 *   retries; a deterministic contract error never rotates. When a
 *   broadcast fails ambiguously (a timeout can mean the node accepted
 *   the transaction but the answer never arrived), the transaction
 *   hash is polled across the other endpoints before anything new is
 *   signed, so a retry can never double spend what already landed.
 * - When every endpoint fails a signed operation, the error says so
 *   plainly (NETWORK_UNREACHABLE_MESSAGE). Raw library strings never
 *   reach a user.
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

function assertSuccess(outcome: any, what: string): void {
  const fail = (detail: unknown): never => {
    const err = new Error(`${what} failed on chain: ${JSON.stringify(detail).slice(0, 300)}`) as Error & {
      deterministic?: boolean;
    };
    // An executed transaction that failed is a fact about the chain,
    // not about the endpoint: never rotate or retry on it.
    err.deterministic = true;
    throw err;
  };
  const status = outcome?.status ?? outcome?.final_execution_status;
  if (status && typeof status === "object" && "Failure" in status) fail(status.Failure);
  // near-api-js throws on failure in most paths; this is a belt and braces check.
  const receipts: any[] = outcome?.receipts_outcome ?? [];
  for (const r of receipts) {
    const s = r?.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) fail(s.Failure);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Endpoint health memory (shared by the read caller and the signed path)
// ---------------------------------------------------------------------------

/** Consecutive provider class failures before an endpoint is cooled down. */
export const ENDPOINT_FAILURE_THRESHOLD = 3;
/** How long a cooled down endpoint is skipped while others are healthy. */
export const ENDPOINT_COOLDOWN_MS = 3 * 60 * 1000;

interface EndpointState {
  failures: number;
  cooldownUntil: number;
}

const endpointStates = new Map<string, EndpointState>();

function endpointState(url: string): EndpointState {
  let s = endpointStates.get(url);
  if (!s) {
    s = { failures: 0, cooldownUntil: 0 };
    endpointStates.set(url, s);
  }
  return s;
}

/** An answered call, even a deterministic RPC error, proves the endpoint is alive. */
export function noteEndpointSuccess(url: string): void {
  const s = endpointState(url);
  s.failures = 0;
  s.cooldownUntil = 0;
}

/**
 * Record a provider class failure (429, 5xx, timeout, connection
 * error). At the threshold the endpoint enters cooldown and the event
 * is logged once, when the cooldown starts.
 */
export function noteEndpointFailure(url: string, now = Date.now()): void {
  const s = endpointState(url);
  s.failures += 1;
  if (s.failures >= ENDPOINT_FAILURE_THRESHOLD && s.cooldownUntil <= now) {
    s.cooldownUntil = now + ENDPOINT_COOLDOWN_MS;
    logWarn(
      "rpc",
      `endpoint ${hostOf(url)} failed ${s.failures} times in a row; cooling it down for ${Math.round(ENDPOINT_COOLDOWN_MS / 60000)} minutes`,
    );
  }
}

export function isEndpointCooled(url: string, now = Date.now()): boolean {
  return endpointState(url).cooldownUntil > now;
}

/** Endpoints in list order, healthy ones first, cooled ones last (never dropped entirely). */
export function orderEndpoints(urls: string[], now = Date.now()): string[] {
  const healthy = urls.filter((u) => !isEndpointCooled(u, now));
  const cooled = urls.filter((u) => isEndpointCooled(u, now));
  return [...healthy, ...cooled];
}

// ---------------------------------------------------------------------------
// Timeouts and RPC error classification
// ---------------------------------------------------------------------------

/** A call that exceeded its timeout budget. Always a provider class failure. */
export class RpcTimeoutError extends Error {
  readonly providerClass = true;
  constructor(label: string, timeoutMs: number) {
    super(`NEAR RPC ${label} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

/**
 * Race a promise against a timeout. The losing promise gets a swallow
 * handler so a late rejection never surfaces as unhandled.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RpcErrorClass = "provider" | "nonce" | "deterministic";

const PROVIDER_MESSAGE_RE =
  /fetch failed|failed to fetch|FetchError|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error|timed out|timeout/i;

/**
 * Sort an error from a signed call into the class that decides what
 * the attempt loop may do with it:
 * - "provider": the endpoint failed us (429, 5xx, timeout, connection
 *   error). Abandon the attempt, rotate.
 * - "nonce": the transaction was rejected for a stale nonce or an
 *   expired block hash. Refetch both on the next endpoint and retry.
 * - "deterministic": the chain answered and the answer is final
 *   (contract panic, insufficient balance, no such account). Never
 *   rotate, never retry. Unknown errors land here on purpose: when in
 *   doubt, do not sign the same intent twice.
 */
export function classifyRpcError(err: any): RpcErrorClass {
  if (!err) return "deterministic";
  if (err.providerClass === true) return "provider";
  if (err.deterministic === true) return "deterministic";
  const type = typeof err.type === "string" ? err.type : "";
  if (type === "InvalidNonce" || type === "Expired") return "nonce";
  if (type === "RetriesExceeded" || type === "TimeoutError") return "provider";
  if (type && type !== "UntypedError") return "deterministic";
  const cause = (err as any).cause;
  if (typeof cause === "number") {
    return cause === 408 || cause === 425 || cause === 429 || cause >= 500 ? "provider" : "deterministic";
  }
  if (err.name === "AbortError") return "provider";
  const msg = String(err?.message ?? err);
  // Nodes that answer in the newer name/cause error format degrade to
  // an "UntypedError" whose message is the whole error JSON; the
  // variant names still appear in it, so match them there.
  if (/invalid\s?nonce/i.test(msg)) return "nonce";
  if (type === "UntypedError" && /expired/i.test(msg)) return "nonce";
  if (PROVIDER_MESSAGE_RE.test(msg)) return "provider";
  return "deterministic";
}

// ---------------------------------------------------------------------------
// Raw JSON RPC views (no signer needed)
// ---------------------------------------------------------------------------

interface RpcResult<T> {
  result?: T;
  error?: any;
}

type RpcError = Error & { retryable?: boolean };

function rpcError(message: string, retryable: boolean): RpcError {
  const err = new Error(message) as RpcError;
  err.retryable = retryable;
  return err;
}

/**
 * One JSON RPC attempt against one endpoint, bounded by the timeout.
 * Retryable failures (HTTP 429, HTTP 5xx, network errors, timeouts,
 * and JSON RPC error code -429, the deprecation rejection the legacy
 * endpoint serves) are flagged so the caller can rotate; deterministic
 * errors (a missing account, a missing method) throw with the same
 * messages callers have always matched on.
 */
async function rpcAttempt<T>(url: string, method: string, params: any, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "velocity", method, params }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (controller.signal.aborted || err?.name === "AbortError") {
      throw rpcError(`NEAR RPC ${method} timed out after ${timeoutMs}ms`, true);
    }
    throw rpcError(`NEAR RPC ${method} network error: ${err?.message ?? err}`, true);
  } finally {
    clearTimeout(timer);
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

export interface RpcCallerOptions {
  /** per attempt timeout; defaults to the configured RPC timeout */
  timeoutMs?: number;
}

/**
 * A JSON RPC caller over an ordered endpoint list. A retryable failure
 * rotates to the next endpoint after a short backoff; whichever
 * endpoint answers becomes the preferred one for the next call, so a
 * rate limited provider is not retried head on for every request.
 * Endpoints in cooldown (see the health memory above) are skipped
 * while any healthy endpoint remains, and every attempt is bounded
 * by the RPC timeout.
 */
export function createRpcCaller(urls: string[], opts: RpcCallerOptions = {}): RpcCaller {
  const timeoutMs = opts.timeoutMs ?? config.rpcTimeoutMs;
  let preferred = 0;
  return {
    urls,
    async call<T>(method: string, params: any): Promise<T> {
      // Attempt order: rotated from the preferred endpoint, healthy
      // endpoints first, cooled ones only when nothing healthy is left.
      const rotated: { idx: number; cooled: boolean }[] = [];
      for (let k = 0; k < urls.length; k++) {
        const idx = (preferred + k) % urls.length;
        rotated.push({ idx, cooled: isEndpointCooled(urls[idx]) });
      }
      const attempts = [...rotated.filter((r) => !r.cooled), ...rotated.filter((r) => r.cooled)];
      let lastErr: any;
      for (let a = 0; a < attempts.length; a++) {
        const { idx } = attempts[a];
        try {
          const value = await rpcAttempt<T>(urls[idx], method, params, timeoutMs);
          preferred = idx;
          noteEndpointSuccess(urls[idx]);
          return value;
        } catch (err: any) {
          lastErr = err;
          if (!err?.retryable) {
            // The endpoint answered; for health purposes it is alive.
            noteEndpointSuccess(urls[idx]);
            throw err;
          }
          noteEndpointFailure(urls[idx]);
          if (a < attempts.length - 1) await sleep(250 * (a + 1));
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
    if (!result || !Array.isArray(result.result)) return undefined;
    const bytes = Buffer.from(result.result);
    if (bytes.length === 0) return undefined;
    const parsed = JSON.parse(bytes.toString("utf8"));
    // Some contracts return their JSON double encoded, as a string that
    // itself contains JSON. Unwrap one such layer when the string plainly
    // holds an object or array. Plain string results (token balances and
    // the like) never start with a brace, so they pass through untouched.
    if (typeof parsed === "string" && parsed.trimStart().startsWith("{")) {
      try {
        return JSON.parse(parsed) as T;
      } catch {
        return parsed as T;
      }
    }
    return parsed as T;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("does not exist") || msg.includes("no contract code") || msg.includes("MethodNotFound") || msg.includes("method not found")) {
      return undefined;
    }
    throw err;
  }
}

/**
 * The permission of one access key on an account ("FullAccess", or a
 * function call permission object), or undefined when the account or
 * the key does not exist. Used to prove a named account is controlled
 * by the same key as the implicit wallet it replaced.
 */
export async function readAccessKeyPermission(accountId: string, publicKey: string): Promise<unknown> {
  try {
    const key = await rpc<{ permission: unknown }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: accountId,
      public_key: publicKey,
    });
    return key.permission;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (
      msg.includes("does not exist") ||
      msg.includes("UNKNOWN_ACCOUNT") ||
      (msg.includes("access key") && msg.includes("not found"))
    ) {
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

/**
 * Shape check for ft_metadata results. Some contracts answer with an
 * incomplete object (or, before viewFunction unwraps it, a string), and
 * callers read symbol and decimals unconditionally, so anything that is
 * not a complete metadata object is treated as no metadata at all.
 */
export function normalizeFtMetadata(raw: unknown): FtMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Partial<FtMetadata>;
  if (typeof m.symbol !== "string" || m.symbol.length === 0) return undefined;
  if (typeof m.decimals !== "number" || !Number.isFinite(m.decimals)) return undefined;
  return {
    spec: typeof m.spec === "string" ? m.spec : "",
    name: typeof m.name === "string" ? m.name : m.symbol,
    symbol: m.symbol,
    decimals: m.decimals,
  };
}

export async function getFtMetadata(contractId: string): Promise<FtMetadata | undefined> {
  const cached = metadataCache.get(contractId);
  if (cached) return cached;
  const meta = normalizeFtMetadata(await viewFunction(contractId, "ft_metadata"));
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
// Writes (signing): our own attempt loop, one endpoint per attempt
// ---------------------------------------------------------------------------

/**
 * The plain words a user sees when a signed operation could not reach
 * the chain through any endpoint. Never a raw library string.
 */
export const NETWORK_UNREACHABLE_MESSAGE =
  "The NEAR network could not be reached through any RPC endpoint right now. Nothing was signed and nothing was spent. Please try again in a few minutes.";

export interface SignedSendDeps {
  /** endpoint list to attempt over; defaults to the configured list */
  urls?: string[];
  /** per call timeout; defaults to the configured RPC timeout */
  timeoutMs?: number;
  /** total attempts across endpoints before giving up; defaults to twice the endpoint count */
  maxAttempts?: number;
  /** budget for confirming an ambiguously failed broadcast by its hash */
  pollBudgetMs?: number;
  /** delay between transaction status polls */
  pollIntervalMs?: number;
  /** injectable sleep for tests */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface SignedSendResult {
  outcome: any;
  txHash: string;
}

/** One endpoint connection with the library's internal retries off: our loop owns rotation. */
function attemptProvider(url: string): InstanceType<typeof providers.JsonRpcProvider> {
  return new providers.JsonRpcProvider({ url }, { retries: 1, wait: 25, backoff: 1 });
}

/**
 * Poll for a transaction outcome by hash across the endpoints. Used
 * when a broadcast call failed ambiguously: the transaction may have
 * landed even though its answer never reached us, and signing a fresh
 * one before ruling that out could double spend. Returns the outcome
 * when any endpoint can see the transaction, undefined when the whole
 * budget passes with every endpoint reporting it unknown.
 */
async function pollTxOutcome(
  txHash: string,
  accountId: string,
  urls: string[],
  deps: SignedSendDeps,
): Promise<any | undefined> {
  const budgetMs = deps.pollBudgetMs ?? 30_000;
  const intervalMs = deps.pollIntervalMs ?? 2_000;
  const sleepFn = deps.sleepFn ?? sleep;
  const deadline = Date.now() + budgetMs;
  let i = 0;
  while (true) {
    const url = urls[i % urls.length];
    i += 1;
    try {
      const provider = attemptProvider(url);
      return await withTimeout(provider.txStatus(txHash, accountId), Math.min(deps.timeoutMs ?? config.rpcTimeoutMs, 15_000), "tx_status");
    } catch {
      // Unknown transaction and provider errors both mean "not visible
      // here yet": keep polling until the budget is spent.
    }
    if (Date.now() >= deadline) return undefined;
    await sleepFn(intervalMs);
  }
}

/**
 * Sign and send one transaction with the full attempt loop described
 * at the top of this file. Resolves with the execution outcome and
 * the transaction hash (known locally before broadcast, which is
 * what makes the ambiguous failure recovery above possible).
 */
export async function sendSignedTransaction(
  creds: WalletCreds,
  receiverId: string,
  actions: any[],
  what: string,
  deps: SignedSendDeps = {},
): Promise<SignedSendResult> {
  const urls = deps.urls ?? config.nearRpcUrls;
  const timeoutMs = deps.timeoutMs ?? config.rpcTimeoutMs;
  const maxAttempts = deps.maxAttempts ?? Math.max(urls.length * 2, 1);
  const keyPair = KeyPair.fromString(creds.secret as any);
  await getKeyStore().setKey(config.network, creds.accountId, keyPair);
  const signer = new InMemorySigner(getKeyStore());
  const ordered = orderEndpoints(urls);

  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = ordered[attempt % ordered.length];
    const provider = attemptProvider(url);
    try {
      const accessKey = await withTimeout(
        provider.query({
          request_type: "view_access_key",
          finality: "optimistic",
          account_id: creds.accountId,
          public_key: keyPair.getPublicKey().toString(),
        } as any),
        timeoutMs,
        "view_access_key",
      );
      if (!accessKey) {
        const err = new Error(`No access key for ${creds.accountId} matches the wallet key.`) as Error & {
          deterministic?: boolean;
        };
        err.deterministic = true;
        throw err;
      }
      const block = await withTimeout(provider.block({ finality: "final" }), timeoutMs, "block");
      const blockHash = utils.serialize.base_decode(block.header.hash);
      const nonce = BigInt((accessKey as any).nonce ?? 0) + 1n;
      const tx = transactions.createTransaction(
        creds.accountId,
        keyPair.getPublicKey(),
        receiverId,
        nonce,
        actions,
        blockHash,
      );
      const [hashBytes, signedTx] = await transactions.signTransaction(tx, signer, creds.accountId, config.network);
      const hash = utils.serialize.base_encode(hashBytes);

      let outcome: any;
      try {
        outcome = await withTimeout(provider.sendTransaction(signedTx), timeoutMs, "send_tx");
      } catch (sendErr: any) {
        const cls = classifyRpcError(sendErr);
        if (cls === "deterministic") throw sendErr;
        if (cls === "nonce") {
          // Stale nonce (or expired block hash): the next attempt
          // refetches both on the next endpoint. Not the endpoint's
          // fault, so no health penalty.
          lastErr = sendErr;
          logError("rpc", `signed ${what} rejected for a stale nonce on ${hostOf(url)}; refetching and retrying`, sendErr);
          continue;
        }
        // Provider class failure mid broadcast: the transaction may
        // have landed anyway. Confirm by hash before signing anew.
        noteEndpointFailure(url);
        logError(
          "rpc",
          `signed ${what} via ${hostOf(url)} failed (${String(sendErr?.message ?? sendErr).slice(0, 160)}); checking transaction ${hash} before retrying`,
        );
        const found = await pollTxOutcome(hash, creds.accountId, ordered, deps);
        if (found) {
          assertSuccess(found, what);
          setChainReady(true);
          return { outcome: found, txHash: hash };
        }
        lastErr = sendErr;
        continue;
      }
      assertSuccess(outcome, what);
      noteEndpointSuccess(url);
      setChainReady(true);
      return { outcome, txHash: hash };
    } catch (err: any) {
      const cls = classifyRpcError(err);
      if (cls === "deterministic") throw err;
      if (cls === "nonce") {
        lastErr = err;
        continue;
      }
      noteEndpointFailure(url);
      logError(
        "rpc",
        `signed ${what} attempt via ${hostOf(url)} failed (${String(err?.message ?? err).slice(0, 160)}); rotating`,
      );
      lastErr = err;
    }
  }
  void lastErr;
  setChainReady(false);
  throw new Error(NETWORK_UNREACHABLE_MESSAGE);
}

export async function transferNear(creds: WalletCreds, toAccountId: string, amountYocto: bigint): Promise<string> {
  if (amountYocto <= 0n) throw new Error("Transfer amount must be positive.");
  const { txHash } = await sendSignedTransaction(creds, toAccountId, [transactions.transfer(amountYocto)], "NEAR transfer");
  return txHash;
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
  gas: bigint = GAS_100_TGAS,
): Promise<string | undefined> {
  const existing = await viewFunction<{ total: string } | null>(contractId, "storage_balance_of", { account_id: holderId });
  if (existing && BigInt(existing.total) > 0n) return undefined;
  const bounds = await viewFunction<{ min: string }>(contractId, "storage_balance_bounds", {});
  const min = bounds?.min ? BigInt(bounds.min) : fallbackMinYocto;
  return callFunction(
    creds,
    contractId,
    "storage_deposit",
    { account_id: holderId, registration_only: true },
    min,
    gas,
  );
}

/** Ensure the holder is registered on a fungible token contract (NEP 145). Returns a tx hash when a deposit was made. */
export async function ensureFtStorage(
  creds: WalletCreds,
  contractId: string,
  holderId: string = creds.accountId,
  gas?: bigint,
): Promise<string | undefined> {
  // 0.00125 NEAR, the usual NEP 145 minimum, when the contract does not publish bounds.
  return ensureContractStorage(creds, contractId, 125n * 10n ** 19n, holderId, gas);
}

export async function transferFt(
  creds: WalletCreds,
  contractId: string,
  toAccountId: string,
  amountRaw: bigint,
  memo?: string,
  gas: bigint = GAS_100_TGAS,
): Promise<string> {
  if (amountRaw <= 0n) throw new Error("Transfer amount must be positive.");
  await ensureFtStorage(creds, contractId, toAccountId, gas);
  return callFunction(
    creds,
    contractId,
    "ft_transfer",
    { receiver_id: toAccountId, amount: amountRaw.toString(), memo: memo ?? "Velocity" },
    ONE_YOCTO,
    gas,
  );
}

/** Wrap native NEAR into wNEAR (near_deposit on the wrap contract). */
export async function wrapNear(creds: WalletCreds, amountYocto: bigint): Promise<string> {
  await ensureFtStorage(creds, config.wnearId);
  return callFunction(creds, config.wnearId, "near_deposit", {}, amountYocto, GAS_100_TGAS);
}

/** Unwrap wNEAR back into native NEAR (near_withdraw on the wrap contract). */
export async function unwrapNear(creds: WalletCreds, amountYocto: bigint): Promise<string> {
  return callFunction(
    creds,
    config.wnearId,
    "near_withdraw",
    { amount: amountYocto.toString() },
    ONE_YOCTO,
    GAS_100_TGAS,
  );
}

/** Generic signed function call used by the exchange flows. */
export async function callFunction(
  creds: WalletCreds,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  attachedDepositYocto: bigint,
  gas: bigint = GAS_300_TGAS,
): Promise<string> {
  const { txHash } = await sendSignedTransaction(
    creds,
    contractId,
    [transactions.functionCall(methodName, args, gas, attachedDepositYocto)],
    `${methodName} on ${contractId}`,
  );
  return txHash;
}

export const GAS = { T100: GAS_100_TGAS, T300: GAS_300_TGAS, ONE_YOCTO };
