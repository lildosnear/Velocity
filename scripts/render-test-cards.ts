import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPnlCard } from "../src/share/pnl";

/**
 * Render one PnL card per tier to ./card-samples for visual verification.
 * Run: npm run render-cards
 */
async function main() {
  const outDir = join(process.cwd(), "card-samples");
  mkdirSync(outDir, { recursive: true });
  const samples: { name: string; pnlPct: number }[] = [
    { name: "legendary", pnlPct: 640 },
    { name: "diamond", pnlPct: 150 },
    { name: "solid", pnlPct: 42 },
    { name: "green", pnlPct: 8 },
    { name: "rekt", pnlPct: -35 },
  ];
  for (const s of samples) {
    const png = await renderPnlCard({
      symbol: "TEST",
      pnlPct: s.pnlPct,
      entryMcUsd: 120_000,
      currentMcUsd: 890_000,
      footerNote: "Sample card",
      botUsername: "VelocityTestBot",
      referralTag: "r_123",
    });
    const path = join(outDir, `${s.name}.png`);
    writeFileSync(path, png);
    console.log("wrote", path, png.length, "bytes");
  }
}

main().catch((err) => {
  console.error("render-cards failed:", err?.message ?? err);
  process.exit(1);
});
