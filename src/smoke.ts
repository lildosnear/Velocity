import { config } from "./config";
import { encryptPrivateKey } from "./crypto";
import {
  accountExists,
  createWallet,
  getFtMetadata,
  readNearBalance,
  rpcBlockHeight,
} from "./near";
import { scanPools } from "./ref";
import { scanDclPools } from "./dcl";

/**
 * Smoke test plus operator helper. Run with: npm run smoke
 * - Connects to the NEAR RPC and prints the block height.
 * - Reads wNEAR metadata and the Ref exchange pool list on this network.
 * - Creates a throwaway implicit wallet locally and prints its account id
 *   and public key (never the secret), plus the balance read path.
 *
 * Encrypt a secret key for .env (FEE_ACCOUNT_SECRET_ENC):
 *   npm run smoke -- --encrypt-key "ed25519:..."
 */
async function main() {
  const args = process.argv.slice(2);
  const encIdx = args.indexOf("--encrypt-key");
  if (encIdx !== -1 && args[encIdx + 1]) {
    console.log(JSON.stringify(encryptPrivateKey(args[encIdx + 1])));
    return;
  }

  console.log(`Network: ${config.network}  RPC: ${config.nearRpcUrl}`);
  const height = await rpcBlockHeight();
  console.log("RPC ok. Block height:", height);

  const wnearMeta = await getFtMetadata(config.wnearId);
  console.log(`wNEAR (${config.wnearId}) metadata:`, wnearMeta ? `${wnearMeta.symbol}, ${wnearMeta.decimals} decimals` : "NOT FOUND");

  const pools = await scanPools(200);
  console.log(`Ref exchange ${config.refExchangeId}: scanned ${pools.length} simple pools (bounded scan).`);
  const wnearPools = pools.filter((p) => p.tokenIds.includes(config.wnearId));
  console.log(`Pools touching wNEAR in that scan: ${wnearPools.length}`);
  for (const p of wnearPools.slice(0, 5)) {
    console.log(`  pool ${p.id}: ${p.tokenIds.join(" / ")}`);
  }

  const dclPools = await scanDclPools(500);
  console.log(`DCL exchange ${config.dclExchangeId}: scanned ${dclPools.length} DCL pools (bounded scan).`);
  if (dclPools.length === 0) {
    console.log("  No DCL pools found on this network. On testnet that is expected today: no DCL contract is deployed there.");
  } else {
    const liquid = dclPools.filter((p) => p.liquidity > 0n && (p.tokenX === config.wnearId || p.tokenY === config.wnearId));
    console.log(`  DCL pools with wNEAR and liquidity in that scan: ${liquid.length}`);
    for (const p of liquid.slice(0, 5)) console.log(`  ${p.poolId} liquidity ${p.liquidity.toString()}`);
  }

  if (config.network === "testnet") {
    // Read only mainnet DCL proof: view calls against the live mainnet
    // contract, never a transaction. This proves the DCL quote path
    // end to end while testnet has no DCL deployment.
    try {
      const res = await fetch("https://rpc.mainnet.near.org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "velocity-smoke",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "optimistic",
            account_id: "dclv2.ref-labs.near",
            method_name: "quote",
            args_base64: Buffer.from(JSON.stringify({
              pool_ids: ["a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near|wrap.near|2000"],
              input_token: "wrap.near",
              output_token: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
              input_amount: "100000000000000000000000",
              tag: "velocity-smoke",
            })).toString("base64"),
          },
        }),
      });
      const json: any = await res.json();
      const out = JSON.parse(Buffer.from(json.result.result).toString("utf8"));
      console.log(`Mainnet DCL read only quote: 0.1 wNEAR -> ${out.amount} raw bridged USDC via dclv2.ref-labs.near.`);
    } catch (err: any) {
      console.log("Mainnet DCL read only quote check failed:", err?.message ?? err);
    }
  }

  const wallet = createWallet();
  console.log("Throwaway implicit wallet (local only, unfunded):");
  console.log("  Account id:", wallet.accountId);
  console.log("  Public key:", wallet.publicKey);
  console.log("  Exists on chain:", await accountExists(wallet.accountId));
  console.log("  Balance read:", await readNearBalance(wallet.accountId), "NEAR");
  console.log("MASTER_KEY loaded:", config.masterKeyHex ? "yes" : "no");
  console.log("Fee wallet configured:", config.feeAccountId || "no (fees will be skipped with a log line)");
}

main().catch((err) => {
  console.error("Smoke failed:", err?.message ?? err);
  process.exit(1);
});
