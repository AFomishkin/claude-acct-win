"use strict";

const test = require("node:test");
const assert = require("node:assert");
const h = require("./helpers");

const accounts = require("../src/accounts");
const ratelimits = require("../src/ratelimits");
const statusline = require("../src/statusline");
const ui = require("../src/ui");

function twoAccounts() {
  h.login("alice");
  accounts.save();
  h.login("bob");
  accounts.save();
}

function draw(input) {
  return statusline.render(input || "{}").text;
}

test("the row lists the accounts, marks the active one, and gives each its own link", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const now = Math.floor(Date.now() / 1000);
  const out = draw(h.session(24, now + 9000, 5, now + 302400));
  assert.match(out, /\x1b\]8;;http:\/\/claude-acct\.localhost\/use\/[0-9a-f]{8}\x07alice@example\.com/);
  assert.match(h.strip(out), /● bob@example\.com 5h 24%↻2h · 7d 5%↻3d/);
  assert.match(h.strip(out), /alice@example\.com {2}│ {2}●/);
});

test("limits stick to the account that produced them", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const now = Math.floor(Date.now() / 1000);
  statusline.run(h.session(80, now + 3600, 30, now + 86400)); // bob's numbers
  accounts.use("alice@example.com");
  // the first numbers after the switch are still bob's: they must not be credited to alice
  statusline.run(h.session(80, now + 3600, 30, now + 86400));
  const rl = ratelimits.read();
  const aliceId = require("../src/gconfig").activeId();
  assert.equal(rl.accounts[aliceId] && rl.accounts[aliceId].five_hour, undefined);
  const out = h.strip(draw(h.session(3, now + 19800, 1, now + 500000)));
  assert.match(out, /● alice@example\.com 5h 3%↻5h/);
  assert.match(out, /bob@example\.com 5h 80%↻/);
});

test("a window whose reset has passed is hidden", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const now = Math.floor(Date.now() / 1000);
  statusline.run(h.session(90, now - 10, 40, now - 10));
  accounts.use("alice@example.com");
  assert.doesNotMatch(h.strip(draw("{}")), /90%/);
});

test("an unsaved active account offers to save it", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  accounts.save();
  h.login("bob"); // bob is not saved
  assert.match(h.strip(draw("{}")), /＋ save/);
});

test("without a login the status line prints nothing", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  assert.equal(draw("{}"), "");
});

test("broken input does not stop the row from being drawn", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  assert.match(h.strip(draw("not json")), /● bob@example\.com/);
});

test("the user's own status line comes first", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice");
  accounts.save();
  const fs = require("fs");
  const path = require("path");
  const settings = require("../src/settings");
  fs.mkdirSync(path.dirname(settings.installStatePath()), { recursive: true });
  fs.writeFileSync(
    settings.installStatePath(),
    JSON.stringify({ originals: { statusLine: { type: "command", command: "node -e \"process.stdout.write('my bar')\"" } } })
  );
  const out = h.strip(draw("{}")).split("\n");
  assert.equal(out[0], "my bar");
  assert.match(out[1], /● alice@example\.com/);
});

test("a narrow terminal shortens the names, collapse/expand override the width", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  process.env.COLUMNS = "40";
  assert.match(h.strip(draw("{}")), /● bob…/);
  process.env.COLUMNS = "200";
  assert.match(h.strip(draw("{}")), /● bob@example\.com/);
  ui.setCollapsed(true);
  assert.match(h.strip(draw("{}")), /● bob…/);
  assert.match(h.strip(draw("{}")), /⤢ expand/);
  ui.setCollapsed(false);
  process.env.COLUMNS = "40";
  assert.match(h.strip(draw("{}")), /● bob@example\.com/);
  process.env.COLUMNS = "200";
});

test("numbers older than an hour show as a question mark, not as a lie", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const now = Math.floor(Date.now() / 1000);
  const aliceId = require("../src/vault").indexRead().accounts.find((a) => a.email === "alice@example.com").id;
  ratelimits.update((rl) => {
    rl.accounts[aliceId] = {
      five_hour: { used_percentage: 50, resets_at: now + 3600 },
      fetchedAt: now - 7200,
      source: "api",
    };
    return rl;
  });
  assert.match(h.strip(draw("{}")), /alice@example\.com \?/);
});

test("an error message lives as a row in the bar and is dismissed by a link", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  ui.notify("switch failed: probe");
  const out = h.strip(draw("{}"));
  assert.match(out, /⚠ switch failed: probe/);
  assert.match(out, /✕ hide/);
  ui.clearNotice();
  assert.doesNotMatch(h.strip(draw("{}")), /⚠/);
});

test("a manual /login to another account also counts as a switch", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  twoAccounts();
  const now = Math.floor(Date.now() / 1000);
  statusline.run(h.session(40, now + 9000, 12, now + 302400)); // bob's numbers
  h.login("alice"); // by hand, without claude-acct
  statusline.run(h.session(40, now + 9000, 12, now + 302400)); // still bob's numbers
  const vault = require("../src/vault");
  const aliceId = vault.indexRead().accounts.find((a) => a.email === "alice@example.com").id;
  const bobId = vault.indexRead().accounts.find((a) => a.email === "bob@example.com").id;
  let rl = ratelimits.read();
  assert.equal(rl.accounts[aliceId] && rl.accounts[aliceId].five_hour, undefined);
  statusline.run(h.session(3, now + 12000, 1, now + 400000)); // and these are alice's already
  rl = ratelimits.read();
  assert.equal(rl.accounts[aliceId].five_hour.used_percentage, 3);
  assert.equal(rl.accounts[bobId].five_hour.used_percentage, 40);
});

test("with no saved accounts the row starts with the controls, with no indent", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  h.login("alice"); // logged in, but nothing saved — as right after install
  const out = h.strip(draw("{}"));
  assert.match(out, /^⤡ collapse {2}＋ save {2}↻ limits$/);
});
