"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const h = require("./helpers");

const env = require("../src/env");
const settings = require("../src/settings");
const usage = require("../src/usage");

function writeSettings(value) {
  fs.writeFileSync(env.settingsPath(), JSON.stringify(value, null, 2));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(env.settingsPath(), "utf8"));
}

const APP = "C:\\Users\\tester\\AppData\\Local\\claude-acct\\app";
const OPENER = path.join(APP, "opener", "claude-acct-opener.exe");

test("install keeps the previous status line and writes in its own", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  writeSettings({
    statusLine: { type: "command", command: "node C:/Users/tester/.claude/statusline.js", padding: 0 },
    theme: "dark",
  });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  const after = readSettings();
  assert.match(after.statusLine.command, /cli\.js statusline$/);
  assert.equal(after.statusLine.padding, 0, "the status line's other fields are kept");
  assert.equal(after.env.BROWSER, OPENER);
  assert.equal(after.env.FORCE_HYPERLINK, "1");
  assert.equal(after.theme, "dark", "the rest of the settings is left alone");
  const state = settings.readState();
  assert.equal(state.originals.statusLine.command, "node C:/Users/tester/.claude/statusline.js");
});

test("installing again does not lose the original status line", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  writeSettings({ statusLine: { type: "command", command: "my-own-bar" } });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  assert.equal(settings.readState().originals.statusLine.command, "my-own-bar");
});

test("a poke only raises the number and changes nothing else", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  writeSettings({ statusLine: { type: "command", command: "my-own-bar" }, theme: "dark" });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  settings.poke();
  const first = readSettings().statusLine.command;
  assert.match(first, / --tick \d+$/);
  settings.poke();
  const second = readSettings().statusLine.command;
  assert.match(second, / --tick \d+$/);
  const value = (c) => Number(/--tick (\d+)$/.exec(c)[1]);
  assert.ok(value(second) > value(first), "the number only goes up");
  assert.equal(readSettings().theme, "dark");
});

test("uninstall puts the settings back as they were", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  writeSettings({ statusLine: { type: "command", command: "my-own-bar" }, env: { FOO: "1" } });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  settings.poke();
  settings.revert();
  const after = readSettings();
  assert.deepEqual(after.statusLine, { type: "command", command: "my-own-bar" });
  assert.deepEqual(after.env, { FOO: "1" }, "our variables are gone, the others stay");
});

test("install without a previous status line does not invent one", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  writeSettings({ theme: "dark" });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  settings.revert();
  assert.equal(readSettings().statusLine, undefined);
});

test("a foreign status line is not taken for ours because of words in its path", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  // A path with both claude-acct and statusline in it: matching by substring would
  // take such a status line for ours and stop drawing it.
  const foreign = {
    type: "command",
    command: "node C:/tmp/claude-acct-probe/my-statusline.js",
  };
  assert.equal(settings.isOurStatusLine(foreign), false);
  writeSettings({ statusLine: foreign });
  settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER });
  assert.equal(settings.isOurStatusLine(readSettings().statusLine), true);
  settings.poke();
  assert.equal(settings.isOurStatusLine(readSettings().statusLine), true, "the tick does not break recognition");
  settings.revert();
  assert.deepEqual(readSettings().statusLine, foreign);
});

test("a broken settings.json is not silently rewritten", (t) => {
  const ctx = h.setup();
  t.after(() => h.cleanup(ctx));
  fs.writeFileSync(env.settingsPath(), "{ this is not json");
  assert.throws(() => settings.apply({ appDir: APP, nodePath: "node", openerPath: OPENER }), /is not a JSON object/);
});

test("the limits endpoint's answer is brought to the row's shape", () => {
  const normalized = usage.normalize(
    JSON.stringify({
      five_hour: { utilization: 24.7, resets_at: "2026-09-15T14:00:00.123456+00:00" },
      seven_day: { utilization: 5, resets_at: null },
    })
  );
  assert.equal(normalized.five_hour.used_percentage, 24);
  assert.equal(normalized.five_hour.resets_at, Math.floor(Date.parse("2026-09-15T14:00:00Z") / 1000));
  assert.equal(normalized.seven_day.used_percentage, 5);
  assert.equal(normalized.seven_day.resets_at, null);
  assert.equal(usage.normalize("{}"), null);
  assert.equal(usage.normalize("not json"), null);
});
