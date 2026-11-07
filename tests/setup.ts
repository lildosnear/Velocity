import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test environment. Must be imported before any src module, because
// src/config reads the environment at import time.
process.env.TELEGRAM_BOT_TOKEN = "test-token-not-real";
process.env.MASTER_KEY = "11".repeat(32);
process.env.NEAR_NETWORK = "testnet";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "velocity-test-"));
process.env.BOT_USERNAME = "VelocityTestBot";
