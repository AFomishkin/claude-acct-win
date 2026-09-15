"use strict";
// Wiring claude-acct into Claude Code's settings.json, and taking it out again.

const fs = require("fs");
const path = require("path");
const env = require("./env");
const util = require("./util");

function installStatePath() {
  return path.join(env.dataDir(), "install.json");
}

function readState() {
  return util.readJson(installStatePath(), {});
}

// Our status line is recognised by OUR command, not by the substring "claude-acct"
// in the string: that can turn up in the path to someone else's script, and then
// the user's own status line would silently stop being drawn.
const OUR_COMMAND = /(^|[\\/"'\s])cli\.js["']?\s+statusline(\s|$)/i;

function isOurStatusLine(statusLine) {
  return Boolean(
    statusLine &&
      typeof statusLine === "object" &&
      typeof statusLine.command === "string" &&
      OUR_COMMAND.test(statusLine.command)
  );
}

function isOurBrowser(value) {
  return typeof value === "string" && /claude-acct-opener/i.test(value);
}

// The status line command: `node <app>/src/cli.js statusline`. On Windows Claude
// Code runs it through Git Bash (probe: MSYSTEM=MINGW64), so paths use forward
// slashes and are quoted when they hold spaces: that way the string works for
// both bash and cmd.exe.
function statusLineCommand(appDir, nodePath) {
  const script = path.join(appDir, "src", "cli.js").replace(/\\/g, "/");
  const nodeFwd = nodePath ? nodePath.replace(/\\/g, "/") : "";
  const node = nodeFwd && /\s/.test(nodeFwd) ? `"${nodeFwd}"` : nodeFwd || "node";
  const quoted = /\s/.test(script) ? `"${script}"` : script;
  return `${node} ${quoted} statusline`;
}

// apply(): add the status line and the link handler, remembering what was there before us.
function apply({ appDir, nodePath, openerPath }) {
  const settingsFile = env.settingsPath();
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  let current = {};
  if (fs.existsSync(settingsFile)) {
    const parsed = util.readJson(settingsFile, null);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      util.die(`${settingsFile} is not a JSON object; fix it and run the installer again`);
    }
    current = parsed;
    const backupDir = path.join(env.ensureDataDir(), "backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    fs.copyFileSync(settingsFile, path.join(backupDir, `settings.json.${stamp}`));
  } else {
    env.ensureDataDir();
  }

  const state = readState();
  // The originals are what the user had before the FIRST install. While installed,
  // the file holds ours plus the user's later edits, so a reinstall keeps the
  // originals it already has instead of re-deriving them.
  const originals =
    state.originals && typeof state.originals === "object"
      ? state.originals
      : {
          statusLine: current.statusLine,
          env: {
            BROWSER: current.env && current.env.BROWSER,
            FORCE_HYPERLINK: current.env && current.env.FORCE_HYPERLINK,
          },
        };
  const shellBrowser =
    state.shellBrowser ||
    (process.env.BROWSER && !isOurBrowser(process.env.BROWSER) ? process.env.BROWSER : null);

  const nextState = {
    version: 1,
    appDir,
    nodePath: nodePath || "node",
    openerPath,
    settingsPath: settingsFile,
    originals,
    shellBrowser,
  };

  const keptStatusLineFields = {};
  if (originals.statusLine && typeof originals.statusLine === "object") {
    for (const [key, value] of Object.entries(originals.statusLine)) {
      if (key !== "type" && key !== "command" && key !== "refreshInterval") {
        keptStatusLineFields[key] = value;
      }
    }
  }
  // The periodic re-run is needed: it drives the countdown to a limit's reset and
  // the background refresh of the numbers in an idle session. But every 10 seconds
  // across a dozen open windows is a needless stream of processes, so the default
  // is a minute, and an interval the user set is respected as it is.
  const originalInterval = originals.statusLine && originals.statusLine.refreshInterval;
  const next = { ...current };
  next.statusLine = {
    ...keptStatusLineFields,
    type: "command",
    command: statusLineCommand(appDir, nodePath),
    refreshInterval: Math.max(1, originalInterval || 60),
  };
  if (openerPath) {
    next.env = { ...(current.env || {}), BROWSER: openerPath, FORCE_HYPERLINK: "1" };
  } else if (current.env && isOurBrowser(current.env.BROWSER)) {
    // Installing without clicks while the file holds OUR link handler from an
    // earlier install: a pointer to a file that is gone would break the opening
    // of every link. Put back what was there before us.
    const env0 = originals.env || {};
    next.env = { ...current.env };
    for (const key of ["BROWSER", "FORCE_HYPERLINK"]) {
      if (env0[key] === undefined || env0[key] === null) {
        delete next.env[key];
      } else {
        next.env[key] = env0[key];
      }
    }
    if (Object.keys(next.env).length === 0) {
      delete next.env;
    }
  }

  util.writeJsonAtomic(installStatePath(), nextState);
  util.writeJsonAtomic(settingsFile, next);
  return { settingsFile, state: nextState };
}

// poke(): make every open session redraw its status line now.
// Claude Code re-runs the status line command when it changes in
// settings.json, so the command gets a fresh `--tick <ms>` argument
// (ignored by the script). The value only ever grows, so pokes that land close
// together merge into one redraw instead of cancelling each other out.
function poke() {
  const settingsFile = env.settingsPath();
  if (!fs.existsSync(settingsFile)) {
    return false;
  }
  // Wait our turn: pokes come from clicks, from background rounds and from the
  // row changing its view, and a lost poke is an account row someone never sees redrawn.
  const lock = util.tryLock("poke.lock", 60_000, { tries: 40, waitMs: 50 });
  if (!lock) {
    util.log("poke: gave up waiting for the lock");
    return false;
  }
  try {
    // Claude Code edits this file too (permissions, /config). Between the read and
    // the write the file's fingerprint is compared, and on a mismatch we go round
    // again, so as not to overwrite someone else's edit wholesale.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = stamp(settingsFile);
      const settings = util.readJson(settingsFile, null);
      if (!settings || !isOurStatusLine(settings.statusLine)) {
        return false;
      }
      const command = settings.statusLine.command;
      const previous = /--tick (\d+)$/.exec(command);
      const next = Math.max(util.nowMs(), previous ? Number(previous[1]) + 1 : 0);
      settings.statusLine.command = `${command.replace(/ --tick \d+$/, "")} --tick ${next}`;
      if (stamp(settingsFile) !== before) {
        continue; // the file changed just now — read it again
      }
      util.writeJsonAtomic(settingsFile, settings);
      util.log("poke");
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

function stamp(file) {
  try {
    const info = fs.statSync(file);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "";
  }
}

function statuslineStampPath() {
  return path.join(env.dataDir(), "statusline.at");
}

// Did any status line draw its state after this moment?
function statuslineRanSince(ms) {
  const value = Number(util.readFileOr(statuslineStampPath(), "0"));
  return Number.isFinite(value) && value > ms;
}

function markStatuslineRun() {
  try {
    fs.writeFileSync(statuslineStampPath(), String(util.nowMs()));
  } catch {
    /* the mark must never get in the way of drawing */
  }
}

// revert(): put back in settings.json what was there before us.
function revert() {
  const state = readState();
  const settingsFile = state.settingsPath || env.settingsPath();
  if (!state.originals || !fs.existsSync(settingsFile)) {
    return false;
  }
  const settings = util.readJson(settingsFile, null);
  if (!settings) {
    return false;
  }
  if (!isOurStatusLine(settings.statusLine)) {
    util.warn(`statusLine in ${settingsFile} was changed after installing; leaving it as it is`);
  } else if (state.originals.statusLine === undefined || state.originals.statusLine === null) {
    delete settings.statusLine;
  } else {
    settings.statusLine = state.originals.statusLine;
  }
  if (settings.env && isOurBrowser(settings.env.BROWSER)) {
    const originalEnv = state.originals.env || {};
    for (const key of ["BROWSER", "FORCE_HYPERLINK"]) {
      if (originalEnv[key] === undefined || originalEnv[key] === null) {
        delete settings.env[key];
      } else {
        settings.env[key] = originalEnv[key];
      }
    }
    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }
  util.writeJsonAtomic(settingsFile, settings);
  return true;
}

module.exports = {
  installStatePath,
  readState,
  isOurStatusLine,
  isOurBrowser,
  statusLineCommand,
  apply,
  poke,
  statuslineRanSince,
  markStatuslineRun,
  statuslineStampPath,
  revert,
};
