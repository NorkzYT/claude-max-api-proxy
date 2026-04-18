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

/**
 * Build a stub acquire fn that serializes callers via a promise-chain in
 * memory. Tests use this to exercise the gate logic without touching the
 * real filesystem lock (proper-lockfile requires the target file to exist
 * and writes a real lock directory — fine in prod, noisy in unit tests).
 */
function makeStubAcquire(): (
  lockTarget: string,
) => Promise<() => Promise<void>> {
  let chain: Promise<void> = Promise.resolve();
  return (_lockTarget: string): Promise<() => Promise<void>> => {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => async () => release());
  };
}

test("TokenGate: fast-paths (runs concurrently) outside refresh window", async () => {
  const credsPath = makeTempCredsPath("outside");
  // expiresAt 1h in the future; window is [-30min, +5min], so we are WAY
  // outside it and the gate should not serialize.
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    acquire: makeStubAcquire(),
  });
  assert.equal(gate.isInRefreshWindow(), false);

  const started: number[] = [];
  const finished: number[] = [];
  const slow = async (id: number): Promise<number> => {
    started.push(id);
    await new Promise((r) => setTimeout(r, 20));
    finished.push(id);
    return id;
  };

  const results = await Promise.all([
    gate.runGated(() => slow(1)),
    gate.runGated(() => slow(2)),
    gate.runGated(() => slow(3)),
  ]);

  assert.deepEqual(results.sort(), [1, 2, 3]);
  // All three should have started before any finished (parallel, not serial).
  assert.equal(started.length, 3);
});

test("TokenGate: serializes concurrent calls inside refresh window", async () => {
  const credsPath = makeTempCredsPath("inside");
  // Put `now` 2 minutes BEFORE expiresAt, which is inside the default
  // [expiresAt - 30min, expiresAt + 5min] refresh window.
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 2 * 60 * 1000);

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    acquire: makeStubAcquire(),
  });
  assert.equal(gate.isInRefreshWindow(), true);

  const events: Array<{ id: number; kind: "enter" | "exit" }> = [];
  const slow = async (id: number): Promise<void> => {
    events.push({ id, kind: "enter" });
    await new Promise((r) => setTimeout(r, 15));
    events.push({ id, kind: "exit" });
  };

  await Promise.all([
    gate.runGated(() => slow(1)),
    gate.runGated(() => slow(2)),
    gate.runGated(() => slow(3)),
  ]);

  // Each id must appear as enter -> exit BEFORE the next id's enter.
  assert.deepEqual(events, [
    { id: 1, kind: "enter" },
    { id: 1, kind: "exit" },
    { id: 2, kind: "enter" },
    { id: 2, kind: "exit" },
    { id: 3, kind: "enter" },
    { id: 3, kind: "exit" },
  ]);
});

test("TokenGate: fast-paths when credentials file is missing", async () => {
  const credsPath = path.join(
    os.tmpdir(),
    "token-gate-nonexistent",
    ".credentials.json",
  );
  // Ensure it really doesn't exist.
  try {
    fs.unlinkSync(credsPath);
  } catch {
    /* noop */
  }
  const gate = new TokenGate({
    credentialsPath: credsPath,
    acquire: makeStubAcquire(),
  });
  assert.equal(gate.isInRefreshWindow(), false);

  const v = await gate.runGated(async () => 42);
  assert.equal(v, 42);
});

test("TokenGate: fast-paths on malformed credentials file", async () => {
  const credsPath = makeTempCredsPath("malformed");
  fs.writeFileSync(credsPath, "not json at all");
  const gate = new TokenGate({
    credentialsPath: credsPath,
    acquire: makeStubAcquire(),
  });
  assert.equal(gate.isInRefreshWindow(), false);

  const v = await gate.runGated(async () => "ok");
  assert.equal(v, "ok");
});

test("TokenGate: releases the mutex even when fn throws", async () => {
  const credsPath = makeTempCredsPath("throws");
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 1000); // inside window

  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    acquire: makeStubAcquire(),
  });

  await assert.rejects(
    gate.runGated(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  // Next call should proceed (mutex was released).
  const v = await gate.runGated(async () => "after");
  assert.equal(v, "after");
});

test("TokenGate: fails open when lock acquire itself throws", async () => {
  const credsPath = makeTempCredsPath("acquirefail");
  const now = 1_000_000_000_000;
  writeCreds(credsPath, now + 60 * 1000); // inside window

  let calls = 0;
  const gate = new TokenGate({
    credentialsPath: credsPath,
    now: () => now,
    acquire: async () => {
      calls++;
      throw new Error("lock-fs-read-only");
    },
  });

  // Even though the lock can't be taken, fn runs so the proxy is not
  // deadlocked by a read-only mount or a broken lockfile.
  const v = await gate.runGated(async () => "fallthrough");
  assert.equal(v, "fallthrough");
  assert.equal(calls, 1);
});
