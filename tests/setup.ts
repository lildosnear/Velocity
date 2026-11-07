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
// Keep tests hermetic against the operator .env in the repo root
// (dotenv never overrides variables that are already set).
process.env.CREATOR_ACCOUNT_ID = "";
process.env.CREATOR_SECRET_ENC = "";
process.env.NAME_CREATION_DEPOSIT_NEAR = "";
