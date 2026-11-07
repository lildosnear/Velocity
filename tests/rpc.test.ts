import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRpcUrls } from "../src/config";
import { createRpcCaller } from "../src/near";
import { scanPools } from "../src/ref";

test("rpc url parsing splits a comma separated list, trims and dedupes", () => {
  assert.deepEqual(parseRpcUrls("https://a.example, https://b.example ,https://a.example", "testnet"), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(parseRpcUrls("https://only.example", "testnet"), ["https://only.example"]);
});

test("rpc url parsing falls back to network defaults when unset or blank", () => {
  const testnet = parseRpcUrls(undefined, "testnet");
  assert.equal(testnet[0], "https://rpc.testnet.fastnear.com");
  assert.ok(testnet.includes("https://near-testnet.drpc.org"));
  assert.ok(testnet.includes("https://rpc.testnet.near.org"));
  assert.deepEqual(parseRpcUrls("  , ,", "testnet"), testnet);
  const mainnet = parseRpcUrls(undefined, "mainnet");
  assert.equal(mainnet[0], "https://rpc.mainnet.fastnear.com");
  assert.ok(mainnet.includes("https://near.drpc.org"));
  assert.ok(mainnet.includes("https://rpc.mainnet.near.org"));
});

// --- failover, with fetch stubbed -------------------------------------------

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as any;
  return calls;
}

function jsonRpcOk(result: any): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "velocity", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("rpc caller rotates to the next endpoint on HTTP 429", async () => {
  const calls = stubFetch((url) =>
    url.includes("one") ? new Response("rate limited", { status: 429 }) : jsonRpcOk({ height: 42 }),
  );
  try {
    const caller = createRpcCaller(["https://one.example", "https://two.example"]);
    const out = await caller.call<{ height: number }>("status", []);
    assert.equal(out.height, 42);
    assert.deepEqual(calls, ["https://one.example", "https://two.example"]);
    // The answering endpoint becomes preferred: the next call goes there first.
    await caller.call("status", []);
    assert.equal(calls[2], "https://two.example");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rpc caller rotates on a JSON RPC -429 error body", async () => {
  const calls = stubFetch((url) => {
    if (url.includes("one")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "velocity",
          error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return jsonRpcOk("fine");
  });
  try {
    const caller = createRpcCaller(["https://one.example", "https://two.example"]);
    const out = await caller.call<string>("status", []);
    assert.equal(out, "fine");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rpc caller does not rotate on a deterministic RPC error", async () => {
  const calls = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "velocity",
          error: { code: -32000, message: "account does not exist" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const caller = createRpcCaller(["https://one.example", "https://two.example"]);
    await assert.rejects(caller.call("query", {}), /does not exist/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rpc caller throws the last error after every endpoint rate limits", async () => {
  stubFetch(() => new Response("rate limited", { status: 429 }));
  try {
    const caller = createRpcCaller(["https://one.example", "https://two.example"]);
    await assert.rejects(caller.call("status", []), /HTTP 429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- pool scan cache, with fetch stubbed ------------------------------------

test("pool scan is cached: a second scan within the TTL makes no new RPC calls", async () => {
  let getPoolsCalls = 0;
  globalThis.fetch = (async (_input: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const methodName = body?.params?.method_name;
    if (body.method === "query" && methodName === "get_pools") {
      getPoolsCalls += 1;
      const pools = [
        {
          token_account_ids: ["wrap.testnet", "banana.ft-fin.testnet"],
          amounts: ["1000000", "2000000"],
          total_fee: 30,
          shares_total_supply: "1000",
        },
      ];
      return jsonRpcOk({ result: [...Buffer.from(JSON.stringify(pools))] });
    }
    throw new Error(`unexpected RPC call in cache test: ${body.method} ${methodName}`);
  }) as any;
  try {
    const first = await scanPools();
    assert.equal(first.length, 1);
    assert.equal(first[0].tokenIds[1], "banana.ft-fin.testnet");
    const callsAfterFirst = getPoolsCalls;
    assert.ok(callsAfterFirst >= 1);
    const second = await scanPools();
    assert.equal(second.length, 1);
    assert.equal(getPoolsCalls, callsAfterFirst, "second scan must be served from cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});
