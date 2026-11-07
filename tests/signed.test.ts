import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transactions } from "near-api-js";
import {
  classifyRpcError,
  createWallet,
  NETWORK_UNREACHABLE_MESSAGE,
  RpcTimeoutError,
  sendSignedTransaction,
  type WalletCreds,
} from "../src/near";

/**
 * Failure injection for the signed call attempt loop. The JSON RPC
 * endpoints are stubbed at the fetch layer with the same response
 * shapes a real node produces (including the externally tagged error
 * data nearcore uses), and each test sabotages the first endpoint in
 * a different way: rate limit, timeout, a broadcast that landed
 * despite the error, a stale nonce, a deterministic rejection, and
 * total outage.
 */

const realFetch = globalThis.fetch;

// base58 of 32 zero bytes: a syntactically valid block hash for signing.
const BLOCK_HASH = "11111111111111111111111111111111";

function okOutcome() {
  return {
    status: "SuccessValue",
    transaction: { hash: "StubOutcomeHash" },
    transaction_outcome: { id: "StubOutcomeHash", outcome: { status: "SuccessValue" } },
    receipts_outcome: [],
  };
}

type Reply =
  | { result: any }
  | { http: number; text?: string }
  | { rpcErrorData: any }
  | { hang: true };

type NodeHandler = (method: string, params: any) => Reply | Promise<Reply>;

/** A healthy node: answers access key, block, send and (unknown) tx status. */
function healthyNode(overrides: Partial<Record<string, NodeHandler[string]>> = {}): NodeHandler {
  const base: Record<string, NodeHandler> = {
    query: () => ({
      result: { nonce: 41, permission: "FullAccess", block_height: 1000, block_hash: BLOCK_HASH },
    }),
    block: () => ({ result: { header: { hash: BLOCK_HASH, height: 1000 } } }),
    send_tx: () => ({ result: okOutcome() }),
    tx: () => ({ rpcErrorData: { UnknownTransaction: { tx_hash: "unknown" } } }),
  };
  const merged = { ...base, ...overrides };
  return (method, params) => {
    const handler = merged[method];
    if (!handler) throw new Error(`unexpected RPC method ${method}`);
    return handler(method, params);
  };
}

interface RecordedCall {
  url: string;
  method: string;
}

function installFetch(nodes: Record<string, NodeHandler>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, method: body.method });
    const key = Object.keys(nodes).find((k) => url.includes(k));
    if (!key) throw new Error(`no stub node for ${url}`);
    const reply = await nodes[key](body.method, body.params);
    if ("hang" in reply) return new Promise<Response>(() => {});
    if ("http" in reply) return new Response(reply.text ?? "", { status: reply.http });
    if ("rpcErrorData" in reply) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? "velocity",
          error: { code: -32000, message: "Server error", data: reply.rpcErrorData },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? "velocity", result: reply.result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
  return calls;
}

function countCalls(calls: RecordedCall[], urlPart: string, method: string): number {
  return calls.filter((c) => c.url.includes(urlPart) && c.method === method).length;
}

const wallet = createWallet();
const creds: WalletCreds = { accountId: wallet.accountId, secret: wallet.secret };
const ACTIONS = [transactions.transfer(1000n)];
const RECEIVER = "receiver.testnet";
const FAST_POLL = { pollBudgetMs: 300, pollIntervalMs: 25, sleepFn: async () => {} };

test("signed call succeeds on a healthy endpoint, one broadcast", async () => {
  const calls = installFetch({ "good-a": healthyNode() });
  try {
    const result = await sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
      urls: ["https://good-a.example"],
    });
    assert.equal(typeof result.txHash, "string");
    assert.ok(result.txHash.length > 20);
    assert.equal(countCalls(calls, "good-a", "send_tx"), 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("signed call rotates after an HTTP 429 and refetches the nonce on the next endpoint", async () => {
  const calls = installFetch({
    "rate-a": healthyNode({ send_tx: () => ({ http: 429, text: "rate limited" }) }),
    "good-b": healthyNode(),
  });
  try {
    const result = await sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
      urls: ["https://rate-a.example", "https://good-b.example"],
      ...FAST_POLL,
    });
    assert.ok(result.txHash);
    assert.equal(countCalls(calls, "rate-a", "send_tx"), 1);
    assert.equal(countCalls(calls, "good-b", "send_tx"), 1);
    // The nonce was read on BOTH endpoints: the retry signed fresh.
    assert.equal(countCalls(calls, "rate-a", "query"), 1);
    assert.equal(countCalls(calls, "good-b", "query"), 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("signed call survives a send timeout and lands through the next endpoint", async () => {
  const calls = installFetch({
    "hang-a": healthyNode({ send_tx: () => ({ hang: true }) }),
    "good-b": healthyNode(),
  });
  try {
    const result = await sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
      urls: ["https://hang-a.example", "https://good-b.example"],
      timeoutMs: 250,
      ...FAST_POLL,
    });
    assert.ok(result.txHash);
    assert.equal(countCalls(calls, "hang-a", "send_tx"), 1);
    assert.equal(countCalls(calls, "good-b", "send_tx"), 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a broadcast that landed despite the send error is recovered by hash, never resent", async () => {
  const calls = installFetch({
    "flaky-a": healthyNode({
      send_tx: () => ({ http: 500, text: "internal error" }),
      tx: () => ({ result: okOutcome() }), // the transaction IS on chain
    }),
    "good-b": healthyNode(),
  });
  try {
    const result = await sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
      urls: ["https://flaky-a.example", "https://good-b.example"],
      ...FAST_POLL,
    });
    assert.ok(result.txHash);
    assert.equal(countCalls(calls, "flaky-a", "send_tx"), 1);
    assert.equal(countCalls(calls, "good-b", "send_tx"), 0, "no second broadcast: the first one landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an InvalidNonce rejection refetches and retries on the next endpoint", async () => {
  const calls = installFetch({
    "nonce-a": healthyNode({
      send_tx: () => ({
        rpcErrorData: { InvalidTxError: { InvalidNonce: { ak_nonce: 41, block_height: 1000, tx_nonce: 40 } } },
      }),
    }),
    "good-b": healthyNode(),
  });
  try {
    const result = await sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
      urls: ["https://nonce-a.example", "https://good-b.example"],
      ...FAST_POLL,
    });
    assert.ok(result.txHash);
    assert.equal(countCalls(calls, "nonce-a", "send_tx"), 1);
    assert.equal(countCalls(calls, "good-b", "send_tx"), 1);
    assert.equal(countCalls(calls, "good-b", "query"), 1, "nonce refetched before the retry signature");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a deterministic contract error does not rotate and is not retried", async () => {
  const calls = installFetch({
    "poor-a": healthyNode({
      send_tx: () => ({
        rpcErrorData: {
          InvalidTxError: {
            NotEnoughBalance: { balance: "100", cost: "1000", signer_id: creds.accountId },
          },
        },
      }),
    }),
    "good-b": healthyNode(),
  });
  try {
    await assert.rejects(
      sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
        urls: ["https://poor-a.example", "https://good-b.example"],
        ...FAST_POLL,
      }),
      (err: any) => {
        assert.notEqual(err?.message, NETWORK_UNREACHABLE_MESSAGE);
        return true;
      },
    );
    assert.equal(countCalls(calls, "poor-a", "send_tx"), 1, "exactly one broadcast attempt");
    assert.equal(calls.filter((c) => c.url.includes("good-b")).length, 0, "second endpoint never touched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("when every endpoint is down the error is the plain nothing was signed message", async () => {
  installFetch({
    "down-a": () => ({ http: 500, text: "down" }),
    "down-b": () => ({ http: 503, text: "down" }),
  });
  try {
    await assert.rejects(
      sendSignedTransaction(creds, RECEIVER, ACTIONS, "test transfer", {
        urls: ["https://down-a.example", "https://down-b.example"],
        ...FAST_POLL,
      }),
      (err: any) => {
        assert.equal(err?.message, NETWORK_UNREACHABLE_MESSAGE);
        assert.ok(!/Exceeded/.test(String(err?.message)), "never the raw library string");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("classifyRpcError sorts provider, nonce and deterministic failures", () => {
  assert.equal(classifyRpcError(Object.assign(new Error("too many"), { cause: 429 })), "provider");
  assert.equal(classifyRpcError(Object.assign(new Error("oops"), { cause: 503 })), "provider");
  assert.equal(classifyRpcError(new RpcTimeoutError("send_tx", 20000)), "provider");
  assert.equal(classifyRpcError(Object.assign(new Error("x"), { type: "InvalidNonce" })), "nonce");
  assert.equal(classifyRpcError(Object.assign(new Error("x"), { type: "Expired" })), "nonce");
  assert.equal(classifyRpcError(Object.assign(new Error("x"), { type: "NotEnoughBalance" })), "deterministic");
  assert.equal(classifyRpcError(new Error("Smart contract panicked: boom")), "deterministic");
  // The newer node error format degrades to UntypedError with the
  // variant name inside the message JSON; it must still classify.
  assert.equal(
    classifyRpcError(
      Object.assign(new Error('{"kind":{"name":"InvalidTxError","cause":{"name":"InvalidNonce"}}}'), {
        type: "UntypedError",
      }),
    ),
    "nonce",
  );
});
