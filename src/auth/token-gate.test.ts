import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenGate } from "./token-gate.js";

function writeCreds(filePath: string, expiresAt: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ claudeAiOauth: { expiresAt } }));
}

function makeTempCredsPath(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `token-gate-${suffix}-`));
  return path.join(dir, ".credentials.json");
}

test("TokenGate: fast-paths outside refresh window", async () => {
  const credsPath = makeTempCredsPath("outside");
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    cooldownMs: 0,
  });
  assert.equal(gate.isInRefreshWindow(), false);

  let refreshCalls = 0;
  const waited = await gate.refreshIfNeeded(async () => {
    refreshCalls += 1;
  });

  assert.equal(waited, false);
  assert.equal(refreshCalls, 0);
});

test("TokenGate: shares a single refresh across concurrent callers", async () => {
  const credsPath = makeTempCredsPath("inside");
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 2 * 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    cooldownMs: 0,
  });
  assert.equal(gate.isInRefreshWindow(), true);

  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const entered: number[] = [];
  const finished: number[] = [];
  let startedBeforeFirstFinish = 0;

  const refresh = async (): Promise<void> => {
    refreshCalls += 1;
    await refreshBlocked;
  };

  const runWork = async (id: number): Promise<void> => {
    await gate.refreshIfNeeded(refresh);
    entered.push(id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (finished.length === 0) {
      startedBeforeFirstFinish = entered.length;
    }
    finished.push(id);
  };

  const calls = [runWork(1), runWork(2), runWork(3)];
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(refreshCalls, 1);
  assert.deepEqual(entered, []);

  releaseRefresh();
  await Promise.all(calls);

  assert.equal(refreshCalls, 1);
  assert.equal(startedBeforeFirstFinish, 3);
  assert.deepEqual(finished.sort(), [1, 2, 3]);
});

test("TokenGate: fast-paths when credentials file is missing", async () => {
  const credsPath = path.join(
    os.tmpdir(),
    "token-gate-nonexistent",
    ".credentials.json",
  );
  try {
    fs.unlinkSync(credsPath);
  } catch {
    /* noop */
  }

  const gate = new TokenGate({ credentialsPath: credsPath });
  assert.equal(gate.isInRefreshWindow(), false);
  const waited = await gate.refreshIfNeeded(async () => {});
  assert.equal(waited, false);
});

test("TokenGate: fast-paths on malformed credentials file", async () => {
  const credsPath = makeTempCredsPath("malformed");
  fs.writeFileSync(credsPath, "not json at all");
  const gate = new TokenGate({ credentialsPath: credsPath });

  assert.equal(gate.isInRefreshWindow(), false);
  const waited = await gate.refreshIfNeeded(async () => {});
  assert.equal(waited, false);
});

test("TokenGate: clears the in-flight refresh after an error", async () => {
  const credsPath = makeTempCredsPath("throws");
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    cooldownMs: 0,
  });

  await assert.rejects(
    gate.refreshIfNeeded(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  let calls = 0;
  const waited = await gate.refreshIfNeeded(async () => {
    calls += 1;
  });
  assert.equal(waited, true);
  assert.equal(calls, 1);
});

test("TokenGate: respects the refresh cooldown inside the window", async () => {
  const credsPath = makeTempCredsPath("cooldown");
  let now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    cooldownMs: 60_000,
  });

  let calls = 0;
  await gate.refreshIfNeeded(async () => {
    calls += 1;
  });
  await gate.refreshIfNeeded(async () => {
    calls += 1;
  });

  assert.equal(calls, 1);

  now += 60_001;
  await gate.refreshIfNeeded(async () => {
    calls += 1;
  });
  assert.equal(calls, 2);
});
