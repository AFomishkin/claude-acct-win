"use strict";
// Last known limits per account: what the status line saw in its own
// session and what the endpoint answered. Every open window shares the file, so
// each applies its own small change under a lock instead of a whole snapshot.

const path = require("path");
const env = require("./env");
const util = require("./util");

// Claude Code itself treats cached limits older than an hour as unusable.
const STALE_SECONDS = 3600;

function rlPath() {
  return path.join(env.dataDir(), "ratelimits.json");
}

function read() {
  const value = util.readJson(rlPath(), null);
  if (!value || typeof value !== "object") {
    return { accounts: {} };
  }
  if (!value.accounts || typeof value.accounts !== "object") {
    value.accounts = {};
  }
  return value;
}

// update(fn): change the file under a lock. fn gets the current state and
// returns the new one; returning false means "write nothing" — this is how the
// background round's slot is taken atomically, together with the check that it is free.
// Returns true only when the write actually happened.
function update(fn) {
  const lock = util.tryLock("rl.lock", 60_000, { tries: 50, waitMs: 20 });
  if (!lock) {
    return false;
  }
  try {
    const value = read();
    const next = fn(value);
    if (next === false) {
      return false;
    }
    env.ensureDataDir();
    util.writeJsonAtomic(rlPath(), next || value);
    return true;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

function remove(id) {
  update((rl) => {
    delete rl.accounts[id];
    return rl;
  });
}

module.exports = { STALE_SECONDS, rlPath, read, update, remove };
