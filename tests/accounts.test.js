"use strict";

const test = require("node:test");
const assert = require("node:assert");
const h = require("./helpers");

const accounts = require("../src/accounts");
const gconfig = require("../src/gconfig");
const store = require("../src/store");
const vault = require("../src/vault");

function twoAccounts() {
  h.login("alice");
  accounts.save();
  h.login("bob");
  accounts.save();
}

test("save puts only the account's own keys into the vault", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  const saved = accounts.save();
  const record = vault.get(saved.id);
  assert.equal(record.claudeAiOauth.refreshToken, "rt-alice");
  assert.equal(record.trustedDeviceToken, "tdt-alice");
  assert.equal(record.oauthAccount.emailAddress, "alice@example.com");
  assert.ok(!("mcpOAuth" in record), "MCP logins do not belong to the account");
  assert.equal(vault.indexGet(saved.id).plan, "max");
});

test("switch changes the login and leaves other secrets alone", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const result = accounts.use("alice@example.com");
  assert.equal(result.already, false);
  assert.equal(h.liveRefreshToken(), "rt-alice");
  assert.equal(h.liveEmail(), "alice@example.com");
  const blob = store.read();
  assert.equal(blob.mcpOAuth.srv.accessToken, "mcp-secret", "MCP logins survive the switch");
  assert.equal(blob.trustedDeviceToken, "tdt-alice");
  assert.equal(gconfig.activeId(), result.id);
});

test("switching again to the same account is a no-op", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const result = accounts.use("bob@example.com");
  assert.equal(result.already, true);
  assert.equal(h.liveRefreshToken(), "rt-bob");
});

test("the account being left is saved again with its rotated tokens", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  h.rotate("bob-2"); // Claude Code rotated the tokens while we worked
  const bobId = gconfig.activeId();
  accounts.use("alice@example.com");
  assert.equal(vault.get(bobId).claudeAiOauth.refreshToken, "rt-bob-2");
  accounts.use("bob@example.com");
  assert.equal(h.liveRefreshToken(), "rt-bob-2", "came back to the fresh copy, not the outdated one");
});

test("restore brings back the previous login and can go back again", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  accounts.use("alice@example.com");
  accounts.restore();
  assert.equal(h.liveEmail(), "bob@example.com");
  accounts.restore();
  assert.equal(h.liveEmail(), "alice@example.com");
});

test("the default label is the email, with the organization when emails collide", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  const first = accounts.save();
  h.login("alice", { org: "org-two" });
  const second = accounts.save();
  assert.equal(vault.indexLabel(first.id), "alice@example.com");
  assert.equal(vault.indexLabel(second.id), "alice@example.com (Org alice)");
  assert.notEqual(first.id, second.id);
});

test("rename and rm update the index and the vault", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const renamed = accounts.rename("alice@example.com", "personal");
  assert.equal(vault.indexLabel(renamed.id), "personal");
  accounts.remove("personal");
  assert.equal(vault.indexGet(renamed.id), null);
  assert.equal(vault.get(renamed.id), null);
});

test("looking up an unknown account fails with a clear message", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  assert.throws(() => accounts.use("nobody"), /no saved account matches 'nobody'/);
  assert.equal(h.liveEmail(), "bob@example.com", "a failed lookup switches nothing");
});

test("save without a login fails instead of writing junk", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  assert.throws(() => accounts.save(), /Claude Code is not logged in/);
  assert.equal(vault.indexRead().accounts.length, 0);
});

test("syncActive updates the active account's copy", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  const saved = accounts.save();
  assert.equal(accounts.syncActive(), false, "nothing to change");
  h.rotate("alice-2");
  assert.equal(accounts.syncActive(), true);
  assert.equal(vault.get(saved.id).claudeAiOauth.refreshToken, "rt-alice-2");
});
