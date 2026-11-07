import "dotenv/config";

/**
 * Operator diagnostic. Run with: npm run doctor
 *
 * Checks the things that actually break this bot in the field and
 * prints one plain PASS, FAIL or SKIP line per check, so the output
 * can be pasted into a chat and read at a glance:
 * - env completeness for the configured network (names only, never
 *   values: this script prints no secret, key or token, ever)
 * - every configured RPC endpoint answering, with rough latency
 * - Ref and DCL contract reachability and pool counts
 * - store file integrity and user count
 * - fee and creator wallet configuration and on chain existence
 * - MASTER_KEY decryption sanity when users exist
 *
 * Exit code is 1 when any check FAILs, 0 otherwise.
 */

type Status = "PASS" | "FAIL" | "SKIP";

let failures = 0;

function report(name: string, status: Status, detail: string): void {
  if (status === "FAIL") failures += 1;
  console.log(`[${status}] ${name}: ${detail}`);
}

async function probeEndpoint(url: string): Promise<{ ok: boolean; ms: number; height?: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "status", params: [] }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    const json: any = await res.json().catch(() => null);
    const height = json?.result?.sync_info?.latest_block_height;
    if (typeof height !== "number") return { ok: false, ms, error: "answered without a block height" };
    return { ok: true, ms, height };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log("Velocity doctor");
  console.log("===============");

  // Env completeness, checked on raw env first: src/config throws on
  // a missing required variable, and the doctor's job is to SAY which
  // one is missing, not to die on the import.
  for (const name of ["TELEGRAM_BOT_TOKEN", "MASTER_KEY"]) {
    report(`env ${name}`, process.env[name] ? "PASS" : "FAIL", process.env[name] ? "set" : "missing (required, see .env.example)");
  }
  if (process.env.MASTER_KEY) {
    const shape = /^[0-9a-fA-F]{64}$/.test(process.env.MASTER_KEY);
    report("env MASTER_KEY shape", shape ? "PASS" : "FAIL", shape ? "64 hex chars" : "not 64 hex chars (must be 32 bytes in hex)");
  }
  const networkRaw = (process.env.NEAR_NETWORK ?? "testnet").toLowerCase();
  report(
    "env NEAR_NETWORK",
    networkRaw === "testnet" || networkRaw === "mainnet" ? "PASS" : "FAIL",
    `network is ${networkRaw}`,
  );

  let config: (typeof import("../src/config"))["config"];
  try {
    ({ config } = await import("../src/config"));
  } catch (err: any) {
    report("config load", "FAIL", String(err?.message ?? err).slice(0, 200));
    return finish();
  }
  report(
    "config",
    "PASS",
    `${config.network}, trading ${config.tradingEnabled ? "enabled" : "PAUSED"}, max trade ${config.maxTradeNear} NEAR, RPC timeout ${config.rpcTimeoutMs}ms`,
  );

  // RPC endpoints, each one on its own (the bot rotates; the doctor
  // names names).
  for (const url of config.nearRpcUrls) {
    const probe = await probeEndpoint(url);
    report(
      `rpc ${url}`,
      probe.ok ? "PASS" : "FAIL",
      probe.ok ? `answered in ${probe.ms}ms, block ${probe.height}` : `no answer in ${probe.ms}ms (${probe.error})`,
    );
  }

  const { accountExists, withTimeout } = await import("../src/near");
  const { scanPools } = await import("../src/ref");
  const { scanDclPools } = await import("../src/dcl");

  // Contracts and pool counts.
  try {
    const exists = await withTimeout(accountExists(config.refExchangeId), 45_000, "ref_exists");
    const pools = exists ? await withTimeout(scanPools(), 90_000, "ref_scan") : [];
    report(
      `contract Ref exchange (${config.refExchangeId})`,
      exists ? "PASS" : "FAIL",
      exists ? `reachable, ${pools.length} simple pools in scan` : "account not found on this network",
    );
  } catch (err: any) {
    report(`contract Ref exchange (${config.refExchangeId})`, "FAIL", String(err?.message ?? err).slice(0, 160));
  }
  try {
    const exists = await withTimeout(accountExists(config.dclExchangeId), 45_000, "dcl_exists");
    const pools = exists ? await withTimeout(scanDclPools(), 90_000, "dcl_scan") : [];
    if (!exists && config.network === "testnet") {
      report(`contract DCL exchange (${config.dclExchangeId})`, "PASS", "not deployed on testnet (expected; routing uses simple pools)");
    } else if (!exists) {
      report(`contract DCL exchange (${config.dclExchangeId})`, "FAIL", "account not found on this network");
    } else {
      const bad = config.network === "mainnet" && pools.length === 0;
      report(
        `contract DCL exchange (${config.dclExchangeId})`,
        bad ? "FAIL" : "PASS",
        `${pools.length} DCL pools in scan${config.network === "testnet" && pools.length === 0 ? " (none on testnet, expected)" : ""}`,
      );
    }
  } catch (err: any) {
    report(`contract DCL exchange (${config.dclExchangeId})`, "FAIL", String(err?.message ?? err).slice(0, 160));
  }

  // Store integrity, user count, master key sanity.
  const { inspectStore, verifyStoredSecrets } = await import("../src/store");
  const inspection = inspectStore();
  report(
    "store file",
    !inspection.exists ? "PASS" : inspection.parses ? "PASS" : "FAIL",
    !inspection.exists
      ? `no store yet at ${inspection.path} (created on first user)`
      : inspection.parses
        ? `${inspection.path} parses, ${inspection.userCount} user(s), ${inspection.backupCount} backup(s) kept`
        : `${inspection.path} does not parse (load falls back to a backup if one is readable)`,
  );
  const secrets = verifyStoredSecrets();
  if (secrets.userCount === 0) {
    report("master key decryption", "PASS", "no stored wallets yet, nothing to verify");
  } else {
    report(
      "master key decryption",
      secrets.ok ? "PASS" : "FAIL",
      secrets.ok
        ? `a stored secret decrypts under MASTER_KEY (${secrets.userCount} user(s) in store)`
        : `MASTER_KEY does not match the stored wallets: ${secrets.detail}`,
    );
  }

  // Fee and creator wallets.
  if (!config.feeAccountId) {
    report("fee wallet", "SKIP", "FEE_ACCOUNT_ID not set; the bot fee is skipped on every trade");
  } else {
    try {
      const exists = await withTimeout(accountExists(config.feeAccountId), 45_000, "fee_exists");
      report(
        "fee wallet",
        exists ? "PASS" : "FAIL",
        exists
          ? `${config.feeAccountId} exists on chain; payout key ${config.feeAccountSecretEnc ? "configured" : "not configured (referral payouts stay banked)"}`
          : `${config.feeAccountId} not found on this network`,
      );
    } catch (err: any) {
      report("fee wallet", "FAIL", String(err?.message ?? err).slice(0, 160));
    }
  }
  if (!config.creatorAccountId) {
    report("creator wallet", "SKIP", "CREATOR_ACCOUNT_ID not set; named wallets are dormant");
  } else {
    try {
      const exists = await withTimeout(accountExists(config.creatorAccountId), 45_000, "creator_exists");
      report(
        "creator wallet",
        exists ? "PASS" : "FAIL",
        exists
          ? `${config.creatorAccountId} exists on chain; named wallets claim ${config.nameSuffix} names through ${config.registrarId}`
          : `${config.creatorAccountId} not found on this network`,
      );
    } catch (err: any) {
      report("creator wallet", "FAIL", String(err?.message ?? err).slice(0, 160));
    }
  }

  finish();
}

function finish(): void {
  console.log("===============");
  console.log(failures === 0 ? "Doctor: all checks passed." : `Doctor: ${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error("Doctor crashed:", err?.message ?? err);
  process.exit(1);
});
