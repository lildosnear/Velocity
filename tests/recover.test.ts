import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "grammy";
import { registerCommands } from "../src/commands";
import { encryptPrivateKey } from "../src/crypto";
import { createWallet } from "../src/near";
import {
  PARKED_FUNDS_HINT,
  pollForArrival,
  recoverParkedFunds,
  type ParkedFundsDeps,
} from "../src/market";
import { store, type TradedToken, type UserRecord } from "../src/store";
import type { NamePromptDeps } from "../src/names";

/**
 * Parked funds tests. Two layers:
 * - pollForArrival and recoverParkedFunds against stubbed balance
 *   readers and chain operations (no network): the verification
 *   polling that stops one lagging RPC read from failing a trade
 *   whose output really arrived, and the recovery walk that pulls
 *   internal exchange balances back to the wallet.
 * - Handler level tests with a fake Telegram API, the same harness
 *   as the name prompt tests: /recover reply lines, the nothing
 *   parked one liner, and the /balance parked line appearing only
 *   when an internal balance is nonzero.
 */

const BANANA: TradedToken = { id: "banana.ft-fin.testnet", symbol: "BANANA", decimals: 6 };
const USDC: TradedToken = { id: "usdc.fakes.testnet", symbol: "USDC", decimals: 6 };
const WNEAR: TradedToken = { id: "wrap.testnet", symbol: "wNEAR", decimals: 24 };
const CANDIDATES = [BANANA, USDC, WNEAR];
const CREDS = { accountId: "someone.testnet", secret: "ed25519:unused-in-stubs" };
/** The exact parked wNEAR from the 2026-11-07 live case: the output of a 100 BANANA sale. */
const PARKED_WNEAR_RAW = 3388675453979482967684n;

// ---------------------------------------------------------------------------
// pollForArrival
// ---------------------------------------------------------------------------

test("pollForArrival: output appearing on a later poll is found and the flow continues", async () => {
  const reads = [100n, 100n, 100n, 175n];
  let i = 0;
  let sleeps = 0;
  const gained = await pollForArrival(
    async () => reads[Math.min(i++, reads.length - 1)],
    100n,
    { attempts: 6, delayMs: 5, sleep: async () => { sleeps += 1; } },
  );
  assert.equal(gained, 75n, "the gain is reported once a read rises above the before balance");
  assert.equal(i, 4, "polling stopped as soon as the output appeared");
  assert.equal(sleeps, 3, "sleeps happen only between reads");
});

test("pollForArrival: a sustained absence across the whole budget still fails honestly", async () => {
  let reads = 0;
  const gained = await pollForArrival(
    async () => { reads += 1; return 50n; },
    50n,
    { attempts: 4, delayMs: 1, sleep: async () => {} },
  );
  assert.equal(gained, 0n, "no gain is reported when nothing ever arrives");
  assert.equal(reads, 4, "the full retry budget is spent before giving up");
});

test("pollForArrival: a failed read is not treated as absence, polling continues past RPC errors", async () => {
  let i = 0;
  const gained = await pollForArrival(
    async () => {
      i += 1;
      if (i < 3) throw new Error("rpc endpoint down");
      return 90n;
    },
    10n,
    { attempts: 5, delayMs: 1, sleep: async () => {} },
  );
  assert.equal(gained, 80n);
});

test("the no-output failure hint tells the user about /recover", () => {
  assert.ok(PARKED_FUNDS_HINT.includes("/recover"));
  assert.ok(PARKED_FUNDS_HINT.includes("parked inside the exchange"));
});

// ---------------------------------------------------------------------------
// recoverParkedFunds
// ---------------------------------------------------------------------------

function stubParked(
  deposits: Record<string, bigint>,
  opts: { failWithdraw?: Set<string>; failRead?: Set<string> } = {},
) {
  const calls = {
    withdraw: [] as { tokenId: string; raw: bigint }[],
    unwrap: [] as bigint[],
  };
  const deps: ParkedFundsDeps = {
    readDeposit: async (_creds, tokenId) => {
      if (opts.failRead?.has(tokenId)) throw new Error("read boom");
      return deposits[tokenId] ?? 0n;
    },
    withdraw: async (_creds, tokenId, raw) => {
      if (opts.failWithdraw?.has(tokenId)) throw new Error("withdraw boom");
      calls.withdraw.push({ tokenId, raw });
      return `wtx-${tokenId}`;
    },
    unwrap: async (_creds, raw) => {
      calls.unwrap.push(raw);
      return "utx";
    },
    extraCandidates: async () => [],
  };
  return { deps, calls };
}

test("recoverParkedFunds: withdraws nonzero balances, skips zeros, unwraps wNEAR to NEAR", async () => {
  const { deps, calls } = stubParked({
    [BANANA.id]: 100_000_000n, // the unswapped 100 BANANA from the live case
    [USDC.id]: 0n,
    [WNEAR.id]: PARKED_WNEAR_RAW,
  });
  const outcome = await recoverParkedFunds(CREDS, CANDIDATES, deps);
  assert.deepEqual(
    calls.withdraw.map((c) => c.tokenId).sort(),
    [BANANA.id, WNEAR.id].sort(),
    "only the nonzero balances are withdrawn",
  );
  assert.deepEqual(calls.unwrap, [PARKED_WNEAR_RAW], "the wNEAR is unwrapped for its full parked amount");
  assert.equal(outcome.recovered.length, 2);
  assert.equal(outcome.failures.length, 0);
  const banana = outcome.recovered.find((r) => r.token.id === BANANA.id)!;
  assert.equal(banana.amount, 100);
  assert.equal(banana.unwrapped, false);
  const wnear = outcome.recovered.find((r) => r.token.id === WNEAR.id)!;
  assert.equal(wnear.unwrapped, true);
  assert.ok(Math.abs(wnear.amount - 0.003388675453979483) < 1e-15);
  assert.equal(outcome.parked.length, 2);
});

test("recoverParkedFunds: one token failing to withdraw does not abort the rest, and is reported", async () => {
  const { deps, calls } = stubParked(
    { [BANANA.id]: 100_000_000n, [WNEAR.id]: PARKED_WNEAR_RAW },
    { failWithdraw: new Set([BANANA.id]) },
  );
  const outcome = await recoverParkedFunds(CREDS, CANDIDATES, deps);
  assert.equal(outcome.recovered.length, 1);
  assert.equal(outcome.recovered[0].token.id, WNEAR.id, "the wNEAR still landed");
  assert.deepEqual(calls.unwrap, [PARKED_WNEAR_RAW]);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].token.id, BANANA.id);
  assert.equal(outcome.failures[0].raw, 100_000_000n, "the failed amount stays visible for a retry");
  assert.ok(outcome.failures[0].error.includes("withdraw boom"));
});

test("recoverParkedFunds: a failed balance read is reported per token and never read as zero", async () => {
  const { deps } = stubParked(
    { [BANANA.id]: 5_000_000n },
    { failRead: new Set([USDC.id]) },
  );
  const outcome = await recoverParkedFunds(CREDS, CANDIDATES, deps);
  assert.equal(outcome.recovered.length, 1, "the readable token still recovers");
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].token.id, USDC.id);
  assert.equal(outcome.failures[0].raw, undefined, "a read failure carries no amount: its balance is unknown, not zero");
});

test("recoverParkedFunds: nothing parked recovers nothing and reports nothing", async () => {
  const { deps, calls } = stubParked({});
  const outcome = await recoverParkedFunds(CREDS, CANDIDATES, deps);
  assert.equal(outcome.recovered.length, 0);
  assert.equal(outcome.failures.length, 0);
  assert.equal(outcome.parked.length, 0);
  assert.equal(calls.withdraw.length, 0, "safe to run repeatedly: no withdraw is attempted");
  assert.equal(calls.unwrap.length, 0);
});

// ---------------------------------------------------------------------------
// Handlers (fake Telegram API)
// ---------------------------------------------------------------------------

interface SentMessage {
  chatId: number;
  text: string;
}

async function makeBot(parkedDeps: ParkedFundsDeps) {
  const sent: SentMessage[] = [];
  const errors: unknown[] = [];
  const bot = new Bot("test-token-not-real");
  let msgId = 0;
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === "getMe") {
      return {
        ok: true,
        result: {
          id: 4242,
          is_bot: true,
          first_name: "VelocityTest",
          username: "VelocityTestBot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      } as any;
    }
    if (method === "sendMessage") {
      sent.push({ chatId: payload.chat_id, text: payload.text });
      msgId += 1;
      return {
        ok: true,
        result: { message_id: msgId, date: 1700000000, chat: { id: payload.chat_id, type: "private" } },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  bot.catch((err) => {
    errors.push(err.error ?? err);
  });
  const nameDeps: NamePromptDeps = {
    enabled: () => false,
    isNamed: () => false,
    claim: async () => ({ state: "failed", reason: "unused in recover tests" }),
  };
  registerCommands(bot, nameDeps, parkedDeps);
  await bot.init();
  return { bot, sent, errors };
}

let updateSeq = 0;
function textUpdate(fromId: number, text: string) {
  updateSeq += 1;
  const isCommand = text.startsWith("/");
  return {
    update_id: updateSeq,
    message: {
      message_id: updateSeq,
      date: 1700000000,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Tester" },
      text,
      ...(isCommand
        ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] }
        : {}),
    },
  } as any;
}

function seedUser(telegramId: number, tokens: Record<string, TradedToken> = {}): UserRecord {
  const wallet = createWallet();
  const user: UserRecord = {
    telegramId,
    accountId: wallet.accountId,
    encSecret: encryptPrivateKey(wallet.secret),
    tokens,
    payCurrency: "NEAR",
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  return user;
}

test("/recover: parked BANANA and wNEAR come back with plain lines, wNEAR unwrapped", async () => {
  seedUser(800101, { [BANANA.id]: BANANA });
  const { deps, calls } = stubParked({
    [BANANA.id]: 100_000_000n,
    [WNEAR.id]: PARKED_WNEAR_RAW,
  });
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(800101, "/recover"));
  assert.deepEqual(errors, []);
  const all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Recovered 100 BANANA from the exchange, now in your wallet."));
  assert.ok(all.includes("Recovered 0.00338868 NEAR from the exchange (it was parked as wNEAR, now unwrapped), in your wallet."));
  assert.ok(!all.includes("Nothing is parked"));
  assert.deepEqual(calls.unwrap, [PARKED_WNEAR_RAW]);
});

test("/recover: nothing parked gets the one line answer", async () => {
  seedUser(800102, { [BANANA.id]: BANANA });
  const { deps, calls } = stubParked({});
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(800102, "/recover"));
  assert.deepEqual(errors, []);
  const all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Nothing is parked inside the exchange. Everything you own is already in your wallet."));
  assert.equal(calls.withdraw.length, 0);
});

test("/balance: the parked line appears when an internal balance is nonzero", async () => {
  seedUser(800103);
  const { deps } = stubParked({ [WNEAR.id]: 1234000000000000000000n });
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(800103, "/balance"));
  assert.deepEqual(errors, []);
  const all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Your balances:"));
  assert.ok(
    all.includes("You also have 0.001234 wNEAR parked inside the exchange. Send /recover to pull it into your wallet."),
  );
});

test("/balance: no parked line when every internal balance is zero", async () => {
  seedUser(800104);
  const { deps } = stubParked({});
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(800104, "/balance"));
  assert.deepEqual(errors, []);
  const all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Your balances:"));
  assert.ok(!all.includes("parked inside the exchange"));
});

test("/help lists /recover", async () => {
  seedUser(800105);
  const { deps } = stubParked({});
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(800105, "/help"));
  assert.deepEqual(errors, []);
  assert.ok(sent.map((m) => m.text).join("\n").includes("/recover, pull funds parked inside the exchange back into your wallet"));
});
