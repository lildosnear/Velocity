import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "grammy";
import { registerCommands } from "../src/commands";
import { encryptPrivateKey } from "../src/crypto";
import { createWallet } from "../src/near";
import { store, type UserRecord } from "../src/store";
import type { NameAttemptResult, NamePromptDeps } from "../src/names";

/**
 * Handler level tests for the wallet name prompt. The bot runs on a
 * fake Telegram API (a transformer captures sendMessage and answers
 * getMe), and the naming service is stubbed through NamePromptDeps,
 * so no chain calls happen. What is exercised for real: the /start
 * and /name handlers, the message router's prompt interception, and
 * the store records the prompt lives on.
 */

interface SentMessage {
  chatId: number;
  text: string;
}

async function makeBot(deps: NamePromptDeps) {
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
  registerCommands(bot, deps);
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

function seedUser(telegramId: number, extra: Partial<UserRecord> = {}): UserRecord {
  const wallet = createWallet();
  const user: UserRecord = {
    telegramId,
    accountId: wallet.accountId,
    encSecret: encryptPrivateKey(wallet.secret),
    tokens: {},
    payCurrency: "NEAR",
    createdAt: new Date().toISOString(),
    ...extra,
  };
  store.saveUser(user);
  return user;
}

/** A naming service stub: records claims, plays back a result, and applies a created result to the record like the real claim does. */
function stubDeps(opts: { enabled?: boolean; claimResult?: NameAttemptResult } = {}) {
  const calls: { telegramId: number; label: string }[] = [];
  const deps: NamePromptDeps = {
    enabled: () => opts.enabled ?? true,
    isNamed: (user) => !/^[0-9a-f]{64}$/.test(user.accountId),
    claim: async (user, label) => {
      calls.push({ telegramId: user.telegramId, label });
      const result: NameAttemptResult =
        opts.claimResult ?? { state: "created", namedId: `${label}.testnet`, sweptNear: 0.0453, txids: ["stubtx"] };
      if (result.state === "created" && result.namedId) {
        user.legacyAccountId = user.accountId;
        user.accountId = result.namedId;
        user.nameStatus = { state: "created", candidate: label };
        store.saveUser(user);
      }
      return result;
    },
  };
  return { deps, calls };
}

test("/start: a brand new user gets the name prompt set and the ask in the welcome, when naming is configured", async () => {
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700101, "/start"));
  assert.deepEqual(errors, []);
  const user = store.getUser(700101);
  assert.ok(user, "the user record exists");
  assert.equal(user.pendingNamePrompt, true, "the prompt is set on the record");
  assert.equal(calls.length, 0, "no name is claimed or attempted at /start: the user is only asked");
  const welcome = sent.map((m) => m.text).join("\n");
  assert.ok(welcome.includes('Reply with the wallet name you want (for example "myname" gives you myname.testnet)'));
  assert.ok(welcome.includes("or send any command to skip for now"));
  assert.ok(welcome.includes("You can claim a name any time with /name"));
});

test("/start: no prompt and no ask when naming is not configured", async () => {
  const { deps } = stubDeps({ enabled: false });
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700102, "/start"));
  assert.deepEqual(errors, []);
  const user = store.getUser(700102);
  assert.ok(user);
  assert.ok(!user.pendingNamePrompt, "no prompt is set");
  const welcome = sent.map((m) => m.text).join("\n");
  assert.ok(!welcome.includes("Reply with the wallet name you want"));
});

test("/start: a returning nameless user gets a pointer at /name and NO prompt, so nothing intercepts their next message", async () => {
  seedUser(700103);
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700103, "/start"));
  assert.deepEqual(errors, []);
  const user = store.getUser(700103)!;
  assert.ok(!user.pendingNamePrompt, "no prompt is set for a returning user");
  const welcome = sent.map((m) => m.text).join("\n");
  assert.ok(welcome.includes("Tip: run /name to give this wallet a human name"));
  // Their next plain message is not a name claim: nothing answers it.
  sent.length = 0;
  await bot.handleUpdate(textUpdate(700103, "some random words"));
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
});

test("prompt reply: a plain text reply is treated as the name and claimed, prompt cleared, funds sweep reported", async () => {
  const seeded = seedUser(700104, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700104, "swifttrader"));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [{ telegramId: 700104, label: "swifttrader" }]);
  const user = store.getUser(700104)!;
  assert.equal(user.accountId, "swifttrader.testnet");
  assert.equal(user.accountId.split(".").length, 2, "the created id is a top level name, not a subaccount of any project account");
  assert.equal(user.legacyAccountId, seeded.accountId);
  assert.ok(!user.pendingNamePrompt, "success clears the prompt");
  const reply = sent.map((m) => m.text).join("\n");
  assert.ok(reply.includes("Your wallet name is now swifttrader.testnet."));
  assert.ok(reply.includes("Moved 0.0453 NEAR from your old address to the name."));
});

test("prompt reply: any command clears the prompt and runs the command normally", async () => {
  seedUser(700105, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700105, "/help"));
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 0, "the command text is never treated as a name");
  assert.ok(!store.getUser(700105)!.pendingNamePrompt, "the prompt is cleared");
  assert.equal(sent.length, 1, "exactly the command's own reply is sent");
  assert.ok(sent[0].text.includes("/start, create your trading wallet"), "the help command ran");
});

test("prompt reply: skip clears the prompt without claiming, in any case", async () => {
  seedUser(700106, { pendingNamePrompt: true });
  seedUser(700107, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700106, "skip"));
  await bot.handleUpdate(textUpdate(700107, "Skip"));
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 0);
  assert.ok(!store.getUser(700106)!.pendingNamePrompt);
  assert.ok(!store.getUser(700107)!.pendingNamePrompt);
  assert.equal(sent.filter((m) => m.text.includes("Run /name any time you want to claim a name")).length, 2);
});

test("prompt reply: a taken name says so plainly and keeps the prompt open for another try", async () => {
  seedUser(700108, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps({
    claimResult: { state: "unavailable", reason: "takentest.testnet is already taken" },
  });
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700108, "takentest"));
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  assert.equal(store.getUser(700108)!.pendingNamePrompt, true, "the prompt stays open");
  const reply = sent.map((m) => m.text).join("\n");
  assert.ok(reply.includes("takentest.testnet is already taken on chain. Reply with a different name"));
});

test("prompt reply: a name that needs cleaning shows the cleaned form and claims nothing yet, then the cleaned name claims", async () => {
  seedUser(700109, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700109, "King_1504"));
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 0, "nothing is claimed from an unclean name");
  assert.equal(store.getUser(700109)!.pendingNamePrompt, true, "the prompt stays open");
  let reply = sent.map((m) => m.text).join("\n");
  assert.ok(reply.includes("Cleaned up, your name would be: king-1504.testnet"));
  assert.ok(reply.includes("Reply with king-1504 if that is the one you want"));

  sent.length = 0;
  await bot.handleUpdate(textUpdate(700109, "king-1504"));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [{ telegramId: 700109, label: "king-1504" }]);
  assert.equal(store.getUser(700109)!.accountId, "king-1504.testnet");
  assert.ok(!store.getUser(700109)!.pendingNamePrompt);
  reply = sent.map((m) => m.text).join("\n");
  assert.ok(reply.includes("Your wallet name is now king-1504.testnet."));
});

test("prompt reply: text that can never be a name keeps the prompt open and claims nothing", async () => {
  seedUser(700110, { pendingNamePrompt: true });
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700110, "!!!"));
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 0);
  assert.equal(store.getUser(700110)!.pendingNamePrompt, true);
  assert.ok(sent.map((m) => m.text).join("\n").includes("That name cannot be used."));
});

test("/name with no argument sets the prompt and asks, and the following reply claims", async () => {
  seedUser(700111);
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700111, "/name"));
  assert.deepEqual(errors, []);
  assert.equal(store.getUser(700111)!.pendingNamePrompt, true, "/name set the prompt");
  let all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("What wallet name do you want?"));
  assert.ok(all.includes('"myname" gives you myname.testnet'));

  await bot.handleUpdate(textUpdate(700111, "chosenone"));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [{ telegramId: 700111, label: "chosenone" }]);
  assert.equal(store.getUser(700111)!.accountId, "chosenone.testnet");
  assert.ok(!store.getUser(700111)!.pendingNamePrompt);
  all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Your wallet name is now chosenone.testnet."));
});

test("/name with no argument keeps the dormant explanation and sets no prompt when naming is not configured", async () => {
  seedUser(700112);
  const { deps } = stubDeps({ enabled: false });
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700112, "/name"));
  assert.deepEqual(errors, []);
  assert.ok(!store.getUser(700112)!.pendingNamePrompt);
  assert.ok(sent.map((m) => m.text).join("\n").includes("Named wallets are not enabled on this bot yet"));
});

test("/name <name> still claims directly in one step", async () => {
  seedUser(700113);
  const { deps, calls } = stubDeps();
  const { bot, sent, errors } = await makeBot(deps);
  await bot.handleUpdate(textUpdate(700113, "/name directname"));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [{ telegramId: 700113, label: "directname" }]);
  assert.equal(store.getUser(700113)!.accountId, "directname.testnet");
  const all = sent.map((m) => m.text).join("\n");
  assert.ok(all.includes("Creating directname.testnet..."));
  assert.ok(all.includes("Your wallet name is now directname.testnet."));
});
