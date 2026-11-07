import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "../config";
import { getNearUsd, getTokenMarketCapUsd, getTokenPriceNear, getTokenUsdDex } from "../prices";
import { store, type TradeRecord } from "../store";

/**
 * Shareable PnL win cards, ported from Forge with Velocity branding.
 * The card's whole vibe (color, label) shifts with the win rate, so a
 * +1000 percent looks legendary and a loss is honestly rekt.
 *
 * Rendering: one SVG rendered to PNG with sharp, and the mascot
 * composited as a circle at the top left, exactly like Forge did.
 * The Velocity mascot is the speed comet, picked by Desmond on
 * 2026-11-07, kept at assets/mascots/comet.png. It is also the bot
 * profile photo. The source artwork sits inside a rounded tile with
 * white corners outside the tile; the circular mask in mascotCircle
 * crops the inscribed circle of the artwork, which lies fully inside
 * the tile, so no white corners or tile edges ever show on the card.
 */

export interface PnlTier {
  id: "legendary" | "diamond" | "solid" | "green" | "rekt";
  label: string;
  /** main accent color (PnL number, tier label) */
  color: string;
  /** radial glow color in the top corner */
  glow: string;
  /** inclusive lower bound, in percent */
  minPct: number;
}

export const PNL_TIERS: PnlTier[] = [
  { id: "legendary", label: "LEGENDARY", color: "#FFD54A", glow: "#8a6300", minPct: 500 },
  { id: "diamond", label: "DIAMOND HANDS", color: "#FF9E2C", glow: "#8a4400", minPct: 100 },
  { id: "solid", label: "SOLID", color: "#7CFC66", glow: "#1f5c12", minPct: 25 },
  { id: "green", label: "GREEN", color: "#C4F56B", glow: "#33491a", minPct: 0 },
  { id: "rekt", label: "REKT", color: "#FF5C5C", glow: "#631414", minPct: -Infinity },
];

export function pnlTier(pct: number): PnlTier {
  const tier = PNL_TIERS.find((t) => pct >= t.minPct);
  if (!tier) throw new Error("No PnL tier matched, impossible, rekt covers minus infinity.");
  return tier;
}

export interface PnlCardData {
  symbol: string;
  /** percent, e.g. 91.1 or -12.4 */
  pnlPct: number;
  entryMcUsd?: number;
  currentMcUsd?: number;
  /** small line under the referral, e.g. "Closed 420 TOKEN" */
  footerNote?: string;
  botUsername?: string;
  referralTag?: string;
}

const W = 1200;
const H = 630;
const FONT = "Arial, 'Segoe UI', Helvetica, sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fmtMc(v?: number): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function assetsDir(): string {
  // Compiled output (dist/share/pnl.js) resolves through __dirname.
  // The tsx dev runner loads this module without a __dirname global,
  // so fall back to the repo root the npm scripts run from. First
  // candidate that actually holds comet.png wins.
  const candidates: string[] = [];
  if (typeof __dirname !== "undefined") {
    candidates.push(join(__dirname, "..", "..", "assets", "mascots"));
  }
  candidates.push(join(process.cwd(), "assets", "mascots"));
  for (const dir of candidates) {
    if (existsSync(join(dir, "comet.png"))) return dir;
  }
  return candidates[0];
}

let cometCircleCache: Promise<Buffer> | undefined;

/**
 * The comet mascot as a 190x190 circle, Forge style. The resize fills
 * the square from the centre of the artwork and the dest-in circle
 * mask keeps only the inscribed circle, so the white corners and the
 * rounded tile edges of the source art are cut away. Cached: the same
 * circle lands on every card.
 */
function mascotCircle(): Promise<Buffer> {
  if (!cometCircleCache) {
    cometCircleCache = (async () => {
      const size = 190;
      const raw = await sharp(join(assetsDir(), "comet.png")).resize(size, size).toBuffer();
      const mask = Buffer.from(
        `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
      );
      return sharp(raw).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    })();
  }
  return cometCircleCache;
}

/** Network pill printed on the card. Pure, unit tested: mainnet trades are real, so the card says NEAR; testnet cards say NEAR TESTNET. */
export function networkPill(network: string): string {
  return network === "mainnet" ? "NEAR" : "NEAR TESTNET";
}

/** Network wording for the card caption. Pure, unit tested. */
export function networkCaptionName(network: string): string {
  return network === "mainnet" ? "NEAR" : "NEAR testnet";
}

function buildSvg(d: PnlCardData, tier: PnlTier): string {
  const pillW = 40 + tier.label.length * 20;
  const refLink = d.botUsername ? `https://t.me/${d.botUsername}?start=${d.referralTag ?? "ref"}` : "";
  const hookLine =
    config.referralEnabled && d.botUsername
      ? `Get ${config.refereeDiscountPct}% off trading fees`
      : "Trade NEAR tokens on Telegram";
  const networkPillText = networkPill(config.network);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="0.12" cy="0.18" r="0.55">
      <stop offset="0%" stop-color="${tier.glow}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${tier.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.9">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#060607"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g opacity="0.10" stroke="#8E8E93" stroke-width="3" fill="none">
    <rect x="880" y="-140" width="420" height="900" rx="60" transform="rotate(24 1090 310)"/>
    <rect x="1010" y="-140" width="220" height="900" rx="50" transform="rotate(24 1120 310)"/>
  </g>
  <circle cx="151" cy="135" r="98" fill="#101014" stroke="${tier.color}" stroke-width="3"/>
  <text x="272" y="122" font-family="${FONT}" font-size="44" font-weight="800" letter-spacing="4" fill="#FFFFFF">VELOCITY</text>
  <rect x="272" y="150" width="218" height="36" rx="18" fill="#141417" stroke="#2A2A2E" stroke-width="1.5"/>
  <text x="381" y="174" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="700" letter-spacing="3" fill="#9A9AA0">${networkPillText}</text>
  <text x="1140" y="86" text-anchor="end" font-family="${FONT}" font-size="26" fill="#9A9AA0">${esc(hookLine)}</text>
  ${refLink ? `<text x="1140" y="130" text-anchor="end" font-family="${FONT}" font-size="26" font-weight="700" fill="#FFFFFF">${esc(refLink)}</text>` : ""}
  ${d.footerNote ? `<text x="1140" y="168" text-anchor="end" font-family="${FONT}" font-size="22" fill="#6E6E73">${esc(d.footerNote)}</text>` : ""}
  <rect x="60" y="252" width="${pillW}" height="44" rx="22" fill="#141417" stroke="${tier.color}" stroke-width="2"/>
  <text x="${60 + pillW / 2}" y="281" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="800" letter-spacing="4" fill="${tier.color}">${tier.label}</text>
  <text x="60" y="392" font-family="${FONT}" font-size="92" font-weight="800" letter-spacing="6" fill="#FFFFFF">${esc(d.symbol)}</text>
  <text x="60" y="522" font-family="${FONT}" font-size="148" font-weight="800" letter-spacing="2" fill="${tier.color}">${fmtPct(d.pnlPct)}</text>
  <text x="60" y="566" font-family="${FONT}" font-size="24" font-weight="700" letter-spacing="4" fill="#8E8E93">ENTRY MC</text>
  <text x="380" y="566" font-family="${FONT}" font-size="24" font-weight="700" letter-spacing="4" fill="#8E8E93">CURRENT MC</text>
  <line x1="340" y1="540" x2="340" y2="606" stroke="#2A2A2E" stroke-width="2"/>
  <text x="60" y="608" font-family="${FONT}" font-size="40" font-weight="800" fill="#FFFFFF">${fmtMc(d.entryMcUsd)}</text>
  <text x="380" y="608" font-family="${FONT}" font-size="40" font-weight="800" fill="#FFFFFF">${fmtMc(d.currentMcUsd)}</text>
  <text x="1140" y="600" text-anchor="end" font-family="${FONT}" font-size="26" fill="#9A9AA0">Trade NEAR tokens faster, cheaper, easier</text>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
</svg>`;
}

/** Render the full 1200x630 card as a PNG buffer, ready for Telegram. */
export async function renderPnlCard(d: PnlCardData): Promise<Buffer> {
  const tier = pnlTier(d.pnlPct);
  const base = await sharp(Buffer.from(buildSvg(d, tier))).png().toBuffer();
  const mascot = await mascotCircle();
  return sharp(base).composite([{ input: mascot, left: 56, top: 40 }]).png().toBuffer();
}

export function pnlCaption(d: PnlCardData): string {
  const tier = pnlTier(d.pnlPct);
  const emoji = tier.id === "rekt" ? "💀" : tier.id === "legendary" ? "⚡⚡" : "⚡";
  const net = networkCaptionName(config.network);
  return `${fmtPct(d.pnlPct)} on $${d.symbol} ${emoji}\nTraded on ${net} with Velocity.`;
}

/**
 * Average cost basis from the user's buy history (NEAR per token).
 * Simple average over all buys, good enough for a share card.
 * Pure over an explicit trade list so it is unit testable; the store
 * backed wrapper below is what commands use.
 */
export function costBasisFromTrades(
  trades: TradeRecord[],
  tokenId: string,
): { avgPriceNear: number; bought: number } | undefined {
  const buys = trades.filter((t) => t.tokenId === tokenId && t.side === "buy");
  const bought = buys.reduce((s, t) => s + t.tokenAmount, 0);
  const spent = buys.reduce((s, t) => s + t.nearValue, 0);
  if (!(bought > 0) || !(spent > 0)) return undefined;
  return { avgPriceNear: spent / bought, bought };
}

export function costBasis(
  telegramId: number,
  tokenId: string,
): { avgPriceNear: number; bought: number } | undefined {
  return costBasisFromTrades(store.userTrades(telegramId), tokenId);
}

async function marketCaps(
  tokenId: string,
  avgPriceNear: number,
): Promise<{ entryMc?: number; currentMc?: number }> {
  try {
    const [mcNow, priceUsd, nearUsd] = await Promise.all([
      getTokenMarketCapUsd(tokenId),
      getTokenUsdDex(tokenId),
      getNearUsd(),
    ]);
    if (mcNow == null || priceUsd == null || nearUsd == null || !(nearUsd > 0)) return {};
    const supply = mcNow / priceUsd;
    return { currentMc: mcNow, entryMc: avgPriceNear * nearUsd * supply };
  } catch {
    return {};
  }
}

function referral(telegramId: number): Pick<PnlCardData, "botUsername" | "referralTag"> {
  if (!config.botUsername) return {};
  return { botUsername: config.botUsername, referralTag: `r_${telegramId}` };
}

/** Card input for an OPEN position (unrealized PnL). Position size is read live on chain by the caller. */
export async function unrealizedCardInput(
  telegramId: number,
  tokenId: string,
  symbol: string,
  positionAmount: number,
): Promise<PnlCardData> {
  if (!(positionAmount > 0)) throw new Error(`No open ${symbol} position to share.`);
  const basis = costBasis(telegramId, tokenId);
  if (!basis) throw new Error(`No buy history for ${symbol}, so PnL cannot be computed.`);
  const priceNear = await getTokenPriceNear(tokenId);
  const pnlPct = ((priceNear - basis.avgPriceNear) / basis.avgPriceNear) * 100;
  const mcs = await marketCaps(tokenId, basis.avgPriceNear);
  return {
    symbol,
    pnlPct,
    entryMcUsd: mcs.entryMc,
    currentMcUsd: mcs.currentMc,
    footerNote: `Holding ${positionAmount.toFixed(2)} ${symbol}`,
    ...referral(telegramId),
  };
}

/** Card input for a CLOSED sell (realized PnL). */
export async function realizedCardInput(telegramId: number, trade: TradeRecord): Promise<PnlCardData> {
  const basis = costBasis(telegramId, trade.tokenId);
  if (!basis) throw new Error(`No buy history for ${trade.symbol}, so PnL cannot be computed.`);
  const costNear = trade.tokenAmount * basis.avgPriceNear;
  if (!(costNear > 0)) throw new Error("Cost basis is zero, so PnL cannot be computed.");
  const pnlPct = ((trade.nearValue - costNear) / costNear) * 100;
  const mcs = await marketCaps(trade.tokenId, basis.avgPriceNear);
  return {
    symbol: trade.symbol,
    pnlPct,
    entryMcUsd: mcs.entryMc,
    currentMcUsd: mcs.currentMc,
    footerNote: `Closed ${trade.tokenAmount.toFixed(2)} ${trade.symbol}`,
    ...referral(telegramId),
  };
}
