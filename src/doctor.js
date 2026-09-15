"use strict";
// claude-acct doctor: what works, what does not, and what to do about it.

const fs = require("fs");
const path = require("path");
const env = require("./env");
const gconfig = require("./gconfig");
const settings = require("./settings");
const store = require("./store");
const util = require("./util");
const vault = require("./vault");

function run() {
  let failures = 0;
  const ok = (text) => process.stdout.write(`  ok    ${text}\n`);
  const note = (text) => process.stdout.write(`  ⚠     ${text}\n`);
  const bad = (text) => {
    failures += 1;
    process.stdout.write(`  FAIL  ${text}\n`);
  };

  process.stdout.write(`claude-acct ${env.version()} on ${process.platform} (node ${process.versions.node})\n`);

  const blob = store.present() ? store.read() : null;
  if (!store.present()) {
    note(`credentials: not logged in (${env.credentialsFile()}); run /login in Claude Code`);
  } else if (!blob) {
    bad(`credentials: could not read them (${env.credentialsFile()})`);
  } else if (store.oauthValid(blob)) {
    ok("credentials: format recognised");
  } else if (!Object.prototype.hasOwnProperty.call(blob, "claudeAiOauth")) {
    note("credentials: logged out (MCP logins and plugin secrets kept); /login or switch to a saved account");
  } else {
    bad("credentials: unexpected format; switching is disabled until claude-acct is updated");
  }
  if (blob && Object.prototype.hasOwnProperty.call(blob, "enterpriseGateway")) {
    note("a Claude apps gateway login is present; it outranks claude.ai logins, so switching has no effect");
  }

  let indexBroken = false;
  try {
    vault.indexRead();
  } catch (e) {
    indexBroken = true;
    bad(`${e.message}`);
  }

  const active = gconfig.activeId();
  if (indexBroken) {
    // the account list cannot be read — nothing more to say about it
  } else if (active) {
    if (vault.indexGet(active)) {
      ok(`active account is saved: ${vault.indexLabel(active)}`);
    } else {
      note("active account is not saved yet; click ＋ save in the status line or run: claude-acct save");
    }
  } else {
    note(`no logged-in account in ${env.globalConfigPath()}`);
  }

  const overrides = env.overrides();
  if (overrides.length) {
    note(`these take precedence over /login, so switching has no effect: ${overrides.join(", ")}`);
  } else {
    ok("no credential overrides (API keys, tokens, cloud providers)");
  }

  const settingsFile = env.settingsPath();
  const current = util.readJson(settingsFile, {});
  if (settings.isOurStatusLine(current.statusLine)) {
    ok(`status line installed in ${settingsFile}`);
  } else {
    bad(`status line not installed in ${settingsFile}; run install.js`);
  }
  const state = settings.readState();
  if (current.env && settings.isOurBrowser(current.env.BROWSER)) {
    if (fs.existsSync(current.env.BROWSER)) {
      ok(`link handler installed (env.BROWSER → ${current.env.BROWSER})`);
    } else {
      bad(`env.BROWSER points to ${current.env.BROWSER}, but the file is missing; run install.js`);
    }
  } else if (state.version && !state.openerPath) {
    // Installed that way on purpose, without clicks; nothing is broken.
    note("installed without the link handler: clicks are off, switch with claude-acct use");
  } else {
    bad("env.BROWSER does not point to claude-acct-opener; clicks will not work (install.js fixes this)");
  }
  if (process.env.BROWSER && !settings.isOurBrowser(process.env.BROWSER) && state.openerPath) {
    note("this Claude Code session was started before installing: clicks will not work in it, restart the window");
  }
  if (state.originals && state.originals.statusLine && state.originals.statusLine.command) {
    ok(`your previous status line is kept and drawn on the first line: ${state.originals.statusLine.command}`);
  }

  if (current.tui === "fullscreen" || process.env.CLAUDE_CODE_NO_FLICKER === "1") {
    ok("fullscreen rendering is on (clicks in the status line do not work without it)");
  } else {
    note("clicking needs fullscreen rendering; in Claude Code: /tui fullscreen");
  }

  if (process.env.WT_SESSION) {
    ok("terminal: Windows Terminal — Alt+click an account in the status line (Ctrl+click switches too, but Windows Terminal also opens an empty browser tab)");
  } else if (process.env.TERM_PROGRAM === "vscode") {
    note("the VS Code terminal opens links itself; clicks never reach claude-acct — switch with claude-acct use");
  } else if (!process.env.TERM_PROGRAM) {
    note("terminal unknown; run inside Claude Code as: ! claude-acct doctor");
  } else {
    note(`terminal ${process.env.TERM_PROGRAM}: untested; try Alt+click, then Ctrl+click`);
  }

  // A temporary file holding a full set of tokens is left behind when the process
  // dies between the write and the rename: better to notice one.
  const leftovers = [];
  for (const dir of [env.configDir(), env.dataDir(), path.join(env.dataDir(), "vault")]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^\.claude-acct\.\d+\.[a-z0-9]+\.tmp$/.test(name)) {
        leftovers.push(path.join(dir, name));
      }
    }
  }
  if (leftovers.length) {
    note(`temporary files left by an interrupted write (they hold tokens); delete them: ${leftovers.join(", ")}`);
  }

  const shimDir = path.join(env.home(), ".local", "bin");
  if (fs.existsSync(path.join(shimDir, "claude-acct.cmd"))) {
    if (env.onPath(shimDir)) {
      ok(`the claude-acct command is on PATH (${shimDir})`);
    } else {
      note(`${shimDir} is not on PATH — the claude-acct command will not run by name; add the directory to PATH`);
    }
  }

  const projectSettings = path.join(process.cwd(), ".claude", "settings.json");
  if (fs.existsSync(projectSettings)) {
    const project = util.readJson(projectSettings, {});
    if (project.statusLine) {
      note(`${projectSettings} sets its own statusLine, which hides the switcher in this project`);
    }
  }

  return failures === 0;
}

module.exports = { run };
