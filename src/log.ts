import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * File logging for operators.
 *
 * Console output stays exactly as it has always been; this is the
 * second copy, the one that survives the terminal closing. Lines are
 * appended to logs/velocity.log in the project folder (override the
 * directory with VELOCITY_LOG_DIR), one line per event:
 *
 *   2026-11-07T21:14:03.123Z ERROR trade user=123456 buy BANANA failed: ...
 *
 * Rotation is size based and deliberately simple: at about 5 MB the
 * current file becomes velocity.log.1, the old .1 becomes .2, and the
 * old .2 is dropped, so the folder holds at most three files.
 *
 * Logging must never break the bot: every failure inside this module
 * is swallowed. Callers must never pass secrets, encrypted blobs or
 * env values; user ids, actions and transaction ids are the context
 * that belongs here.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE = "velocity.log";

function logDir(): string {
  return process.env.VELOCITY_LOG_DIR ?? join(process.cwd(), "logs");
}

let dirReady = false;

function ensureDir(): void {
  if (dirReady) return;
  mkdirSync(logDir(), { recursive: true });
  dirReady = true;
}

function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // no file yet, nothing to rotate
  }
  if (size < MAX_BYTES) return;
  const oldest = `${file}.2`;
  const middle = `${file}.1`;
  try {
    if (existsSync(oldest)) unlinkSync(oldest);
    if (existsSync(middle)) renameSync(middle, oldest);
    renameSync(file, middle);
  } catch {
    // A failed rotation never blocks the write that follows.
  }
}

function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim();
}

export function logLine(level: "info" | "warn" | "error", scope: string, message: string): void {
  try {
    ensureDir();
    const file = join(logDir(), LOG_FILE);
    rotateIfNeeded(file);
    appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${scope} ${oneLine(message)}\n`, "utf8");
  } catch {
    // Swallowed on purpose: logging never takes the bot down.
  }
}

export function logInfo(scope: string, message: string): void {
  logLine("info", scope, message);
}

export function logWarn(scope: string, message: string): void {
  logLine("warn", scope, message);
}

export function logError(scope: string, message: string, err?: unknown): void {
  const detail = err == null ? "" : `: ${err instanceof Error ? err.message : String(err)}`;
  logLine("error", scope, `${message}${detail}`);
}
