"use strict";
// Checks for what breaks not in the normal case but at the edges: broken files,
// credentials that drifted apart, a slow foreign status line, other processes' locks.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const h = require("./helpers");

const accounts = require("../src/accounts");
const env = require("../src/env");
const settings = require("../src/settings");
const statusline = require("../src/statusline");
const util = require("../src/util");
const vault = require("../src/vault");

function twoAccounts() {
  h.login("alice");
  accounts.save();
  h.login("bob");
  accounts.save();
}

test("a broken ~/.claude.json is not overwritten, and the switch refuses", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const file = h.globalConfigPath();
  const whole = fs.readFileSync(file, "utf8");
  const truncated = whole.slice(0, Math.floor(whole.length * 0.8)); // a write cut off halfway
  fs.writeFileSync(file, truncated);

  assert.throws(() => accounts.use("alice@example.com"), /does not parse as JSON; nothing was changed/);
  assert.equal(fs.readFileSync(file, "utf8"), truncated, "the file is left as it was");
  // and the credentials were not left halfway between the two accounts
  assert.equal(h.liveRefreshToken(), "rt-bob");
});

test("a broken accounts.json does not turn into an empty list", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const file = vault.indexPath();
  fs.writeFileSync(file, '{"accounts": [ {"id": "abc');
  assert.throws(() => accounts.save(), /does not parse as JSON; nothing was changed/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"accounts": [ {"id": "abc');
});

test("a reset time given as a string is not drawn as NaN", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const out = h.strip(
    statusline.render(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: "2026-09-15T14:00:00Z" } } })
    ).text
  );
  assert.doesNotMatch(out, /NaN/);
  assert.match(out, /● bob@example\.com 5h 12%/);
});

test("a slow foreign status line does not hold up the redraw", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  accounts.save();
  const slow = path.join(ctx.root, "slow.js");
  fs.writeFileSync(slow, "setTimeout(() => process.stdout.write('too late'), 30000);");
  fs.mkdirSync(path.dirname(settings.installStatePath()), { recursive: true });
  fs.writeFileSync(
    settings.installStatePath(),
    JSON.stringify({ originals: { statusLine: { type: "command", command: `node ${slow.replace(/\\/g, "/")}` } } })
  );
  const started = Date.now();
  const out = h.strip(statusline.render("{}").text);
  const spent = Date.now() - started;
  assert.ok(spent < 10000, `the redraw took ${spent} ms — the timeout did not fire`);
  assert.doesNotMatch(out, /too late/);
  assert.match(out, /● alice@example\.com/, "the account row is drawn anyway");
});

test("a crashing foreign status line does not take the row down", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  accounts.save();
  fs.mkdirSync(path.dirname(settings.installStatePath()), { recursive: true });
  fs.writeFileSync(
    settings.installStatePath(),
    JSON.stringify({
      originals: { statusLine: { type: "command", command: "node -e \"process.exit(3)\"" } },
    })
  );
  assert.match(h.strip(statusline.render("{}").text), /● alice@example\.com/);
});

test("without COLUMNS the row is drawn in full and does not crash", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  delete process.env.COLUMNS;
  try {
    const out = h.strip(statusline.render("{}").text);
    assert.match(out, /● bob@example\.com/);
    assert.doesNotMatch(out, /…/);
  } finally {
    process.env.COLUMNS = "200";
  }
});

test("CLAUDE_ACCT_COLUMNS sets the width when the terminal did not report one", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  delete process.env.COLUMNS;
  process.env.CLAUDE_ACCT_COLUMNS = "40";
  try {
    assert.match(h.strip(statusline.render("{}").text), /● bob…/);
  } finally {
    delete process.env.CLAUDE_ACCT_COLUMNS;
    process.env.COLUMNS = "200";
  }
});

test("the active account's colour: truecolor, 256 and NO_COLOR", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  delete process.env.NO_COLOR;
  try {
    process.env.COLORTERM = "truecolor";
    assert.match(statusline.render("{}").text, /\x1b\[1;38;2;217;119;87m● \x1b\]8;;/);
    process.env.COLORTERM = "";
    assert.match(statusline.render("{}").text, /\x1b\[1;38;5;173m● /);
    process.env.NO_COLOR = "1";
    const plain = statusline.render("{}").text;
    assert.doesNotMatch(plain, /\x1b\[1;/);
    assert.match(plain, /bob@example\.com/);
  } finally {
    process.env.NO_COLOR = "1";
    delete process.env.COLORTERM;
  }
});

test("install without clicks removes our previous BROWSER instead of leaving a dead one", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  const APP = path.join(ctx.root, "app");
  const OPENER = path.join(APP, "opener", "claude-acct-opener.exe");
  fs.writeFileSync(env.settingsPath(), JSON.stringify({ statusLine: { type: "command", command: "my-own-bar" } }));
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  assert.equal(JSON.parse(fs.readFileSync(env.settingsPath(), "utf8")).env.BROWSER, OPENER);
  settings.apply({ appDir: APP, nodePath: "node", openerPath: null });
  const after = JSON.parse(fs.readFileSync(env.settingsPath(), "utf8"));
  assert.equal(after.env, undefined, "no pointer to a link handler that does not exist is left behind");
});

test("install without clicks leaves a foreign BROWSER alone", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  fs.writeFileSync(
    env.settingsPath(),
    JSON.stringify({ statusLine: { type: "command", command: "my-own-bar" }, env: { BROWSER: "C:/firefox.exe" } })
  );
  settings.apply({ appDir: path.join(ctx.root, "app"), nodePath: "node", openerPath: null });
  assert.equal(JSON.parse(fs.readFileSync(env.settingsPath(), "utf8")).env.BROWSER, "C:/firefox.exe");
});

test("uninstall with a broken settings.json deletes nothing", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  accounts.save();
  settings.apply({
    appDir: path.join(ctx.root, "app"),
    nodePath: "node",
    openerPath: path.join(ctx.root, "app", "opener", "claude-acct-opener.exe"),
  });
  fs.writeFileSync(env.settingsPath(), "{ broken");
  assert.throws(() => require("../src/uninstall").run([]), /nothing was deleted/);
  assert.ok(fs.existsSync(settings.installStatePath()), "the install record is intact");
  assert.equal(vault.indexRead().accounts.length, 1, "the accounts are intact");
});

test("syncActive does not write someone else's tokens into an account's slot", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  const alice = accounts.save();
  // the credentials moved to another organization, while the config still says alice
  const blob = h.readJson(h.credentialsPath(), {});
  blob.organizationUuid = "org-somebody-else";
  blob.claudeAiOauth.refreshToken = "rt-someone-else";
  blob.claudeAiOauth.accessToken = "at-someone-else";
  fs.writeFileSync(h.credentialsPath(), JSON.stringify(blob));
  assert.equal(accounts.syncActive(), false);
  assert.equal(vault.get(alice.id).claudeAiOauth.refreshToken, "rt-alice", "the account's copy is untouched");
});

test("a stale lock is dropped, a live one holds", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  const dir = path.join(env.ensureDataDir(), "lock");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pid"), JSON.stringify({ pid: 999999, at: Date.now() }));
  const lock = util.acquireLock("lock", { tries: 2, waitMs: 5 });
  assert.ok(lock, "a dead owner's lock is taken over");
  lock.release();
  assert.equal(fs.existsSync(dir), false, "no directory left after release");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pid"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.throws(() => util.acquireLock("lock", { tries: 1, waitMs: 5 }), /another claude-acct command is running/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("temp files of an interrupted write are swept up", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  const dir = env.ensureDataDir();
  const stale = path.join(dir, ".claude-acct.999999.abcdef.tmp");
  fs.writeFileSync(stale, '{"claudeAiOauth":{"refreshToken":"secret"}}');
  util.writeJsonAtomic(path.join(dir, "probe.json"), { ok: true });
  assert.equal(fs.existsSync(stale), false, "another process's temp file with tokens is removed");
});

test("the tick counter does not go wrong when the file changes between read and write", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  fs.writeFileSync(env.settingsPath(), JSON.stringify({ statusLine: { type: "command", command: "my-own-bar" } }));
  settings.apply({
    appDir: path.join(ctx.root, "app"),
    nodePath: "node",
    openerPath: path.join(ctx.root, "app", "opener.exe"),
  });
  assert.equal(settings.poke(), true);
  const settingsNow = JSON.parse(fs.readFileSync(env.settingsPath(), "utf8"));
  settingsNow.permissions = { defaultMode: "acceptEdits" }; // an edit made by someone else
  fs.writeFileSync(env.settingsPath(), JSON.stringify(settingsNow, null, 2));
  assert.equal(settings.poke(), true);
  const after = JSON.parse(fs.readFileSync(env.settingsPath(), "utf8"));
  assert.deepEqual(after.permissions, { defaultMode: "acceptEdits" }, "the other edit survived the poke");
});
