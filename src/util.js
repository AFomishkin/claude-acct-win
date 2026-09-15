"use strict";
// Helpers shared by every module: reading and atomically writing JSON,
// the log, locks, hashing, time.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const env = require("./env");

class CaError extends Error {}

function die(message) {
  throw new CaError(message);
}

function warn(message) {
  process.stderr.write(`claude-acct: ${message}\n`);
}

function sha256hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function nowMs() {
  return Date.now();
}

// readJson: "no file" is what the fallback is for; "a file that does not parse" is NOT.
// The difference is fatal: files that are not ours (~/.claude.json, accounts.json) we
// later rewrite whole, and taking a broken file for an empty one erases it.
function readJson(file, fallback) {
  const text = readTextOrNull(file);
  if (text === null) {
    return fallback;
  }
  try {
    return JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    return fallback;
  }
}

// readJsonStrict: the same, but a file that does not parse throws a CaError with the
// message ready. For everything we write over.
function readJsonStrict(file, { what = file } = {}) {
  const text = readTextOrNull(file);
  if (text === null) {
    return null; // no file is a legitimate case
  }
  try {
    return JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    die(`${what} does not parse as JSON; nothing was changed — fix the file`);
  }
  return null;
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      return null;
    }
    throw e;
  }
}

// On Windows the file is sometimes held by an antivirus or Claude Code itself: the rename
// is retried a few times, and a partially written file is never left behind.
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  sweepTemp(dir);
  const tmp = path.join(dir, `.claude-acct.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  // The file may hold tokens: create it readable by its owner only from the start.
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastError = e;
      if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") {
        break;
      }
      sleepSync(20);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* the temp file may already be gone */
  }
  throw lastError;
}

// A temp file carries a full set of tokens. If a process died between writing and
// renaming, it stays forever — so sweep up the ones other processes left behind.
const TEMP_RE = /^\.claude-acct\.(\d+)\.[a-z0-9]+\.tmp$/;

function sweepTemp(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = TEMP_RE.exec(name);
    if (!match) {
      continue;
    }
    const owner = Number(match[1]);
    const file = path.join(dir, name);
    if (owner === process.pid || (alive(owner) && !olderThan(file, 600_000))) {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* another process's file may be busy — sweep it next time */
    }
  }
}

function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // the process is alive, it just is not ours
  }
}

// A lock is a directory holding a record of its owner. Ownership is proven by the
// pid file being created by us (the wx flag) and read back; otherwise two that dropped
// the same stale lock would both get in at once.
const LOCK_MAX_AGE_MS = 15 * 60 * 1000; // in case the pid has been reused
const held = new Map(); // directory -> depth of nested acquisitions IN THIS process

function lockDir(name) {
  return path.join(env.ensureDataDir(), name);
}

function readOwner(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "pid"), "utf8");
    const value = JSON.parse(raw);
    return typeof value === "object" && value ? value : null;
  } catch {
    return null;
  }
}

function tryTake(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== "EEXIST") {
      throw e;
    }
    return false;
  }
  const mine = { pid: process.pid, at: Date.now() };
  try {
    fs.writeFileSync(path.join(dir, "pid"), JSON.stringify(mine), { flag: "wx" });
  } catch {
    return false; // someone else got into the same directory first
  }
  const back = readOwner(dir);
  return Boolean(back && back.pid === mine.pid && back.at === mine.at);
}

// Drop only THE lock we saw as stale: its record first, then the empty
// directory. If someone has already taken it for themselves, rmdir fails.
function dropStale(dir, owner) {
  if (owner) {
    const now = readOwner(dir);
    if (!now || now.pid !== owner.pid || now.at !== owner.at) {
      return;
    }
    try {
      fs.unlinkSync(path.join(dir, "pid"));
    } catch {
      return;
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* already taken by a new owner — which is fine */
  }
}

function releaseLock(dir) {
  const depth = (held.get(dir) || 1) - 1;
  if (depth > 0) {
    held.set(dir, depth);
    return;
  }
  held.delete(dir);
  const owner = readOwner(dir);
  if (owner && owner.pid !== process.pid) {
    return; // not ours — leave it alone
  }
  try {
    fs.unlinkSync(path.join(dir, "pid"));
  } catch {
    /* already released */
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* the directory is already taken by someone else */
  }
}

function acquireLock(name, { tries = 100, waitMs = 100 } = {}) {
  const dir = lockDir(name);
  if (held.has(dir)) {
    held.set(dir, held.get(dir) + 1); // nested acquisition by the same process
    return { release: () => releaseLock(dir) };
  }
  for (let attempt = 0; attempt <= tries; attempt++) {
    if (tryTake(dir)) {
      held.set(dir, 1);
      return { release: () => releaseLock(dir) };
    }
    const owner = readOwner(dir);
    if (owner && (!alive(owner.pid) || Date.now() - (owner.at || 0) > LOCK_MAX_AGE_MS)) {
      dropStale(dir, owner);
      continue;
    }
    if (!owner && olderThan(dir, 60_000)) {
      dropStale(dir, null); // died between mkdir and writing the owner
      continue;
    }
    sleepSync(waitMs);
  }
  const owner = readOwner(dir);
  die(
    `another claude-acct command is running (pid ${owner ? owner.pid : "unknown"}; if it is not, remove ${dir})`
  );
  return null;
}

function withLock(name, fn, opts) {
  const lock = acquireLock(name, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

async function withLockAsync(name, fn, opts) {
  const lock = acquireLock(name, opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// A polite lock: wait a little, then give up — whoever holds it will do the work.
function tryLock(name, staleMs, { tries = 0, waitMs = 50 } = {}) {
  const dir = lockDir(name);
  for (let attempt = 0; attempt <= tries; attempt++) {
    if (olderThan(dir, staleMs)) {
      dropStale(dir, readOwner(dir));
    }
    if (tryTake(dir)) {
      held.set(dir, 1);
      return { release: () => releaseLock(dir) };
    }
    if (attempt < tries) {
      sleepSync(waitMs);
    }
  }
  return null;
}

// An in-process queue: Promise.all over the accounts must not let two network
// operations in where the file lock only holds back OTHER processes.
let queue = Promise.resolve();

function serialize(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function olderThan(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

function readFileOr(file, fallback) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return fallback;
  }
}

// The log: never put secrets in it.
function log(message) {
  try {
    const file = path.join(env.ensureDataDir(), "claude-acct.log");
    try {
      if (fs.statSync(file).size > 200_000) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* a log that cannot be written must never stop the real work */
  }
}

module.exports = {
  CaError,
  die,
  warn,
  sha256hex,
  nowSec,
  nowMs,
  readJson,
  readJsonStrict,
  writeAtomic,
  writeJsonAtomic,
  sweepTemp,
  sleepSync,
  alive,
  acquireLock,
  withLock,
  withLockAsync,
  tryLock,
  serialize,
  olderThan,
  readFileOr,
  log,
};
