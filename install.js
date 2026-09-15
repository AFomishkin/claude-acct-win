#!/usr/bin/env node
"use strict";
// Install or upgrade claude-acct for the current user:
//   node install.js  [--no-clicks] [--dry-run]
//
// What it does: puts a working copy in %LOCALAPPDATA%\claude-acct\app, builds the
// link handler (csc.exe from .NET Framework, nothing to download), sets
// statusLine and env.BROWSER in Claude Code's settings.json, keeping the user's
// own status line, and puts the claude-acct command in ~/.local/bin.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const env = require("./src/env");
const settings = require("./src/settings");
const util = require("./src/util");

const REPO = __dirname;
const USAGE = `Usage: node install.js [--no-clicks] [--dry-run]

  --no-clicks  install without the link handler: switch only with
               claude-acct use; env.BROWSER is left alone
  --dry-run    show what would be done, without changing anything`;

function cscPath() {
  const root = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function removeTree(dir) {
  // On Windows a file in use cannot be deleted, and plenty can hold the directory:
  // the link handler, a background round, antivirus. Hence retries and a clear failure.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// Build and copy into staging, and only then swap out the working copy: if the
// handler does not build, the previous install stays intact.
function buildStaging(staging, wantClicks) {
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(staging, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "VERSION"), path.join(staging, "VERSION"));
  fs.mkdirSync(path.join(staging, "opener"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "opener", "Opener.cs"), path.join(staging, "opener", "Opener.cs"));
  if (!wantClicks) {
    return { exe: null, why: "--no-clicks was given" };
  }
  const csc = cscPath();
  if (!csc) {
    return { exe: null, why: "csc.exe from .NET Framework was not found" };
  }
  const exe = path.join(staging, "opener", "claude-acct-opener.exe");
  try {
    execFileSync(csc, ["-nologo", "-target:winexe", `-out:${exe}`, path.join(staging, "opener", "Opener.cs")], {
      stdio: "pipe",
    });
  } catch (e) {
    const details = ((e.stdout || "") + (e.stderr || "") || e.message).toString().trim().split("\n")[0];
    return { exe: null, why: `csc.exe failed to build the link handler: ${details}` };
  }
  return fs.existsSync(exe) ? { exe } : { exe: null, why: "the link handler did not build" };
}

function swapIn(appDir, staging) {
  const retired = `${appDir}.old`;
  removeTree(retired);
  if (fs.existsSync(appDir)) {
    try {
      fs.renameSync(appDir, retired);
    } catch (e) {
      removeTree(staging);
      util.die(
        `could not free ${appDir} (${e.code}): a running claude-acct process holds it. ` +
          "Wait half a minute after the last switch and try again"
      );
    }
  }
  fs.renameSync(staging, appDir);
  removeTree(retired);
}

function writeOpenerConf(appDir, { nodePath, originalBrowser }) {
  const lines = [
    "# claude-acct: where the link handler passes a clicked link",
    `node=${nodePath}`,
    `cli=${path.join(appDir, "src", "cli.js")}`,
    `browser=${originalBrowser || ""}`,
    "",
  ];
  fs.writeFileSync(path.join(appDir, "opener", "opener.conf"), lines.join("\r\n"), "utf8");
}

// Two shims: .cmd for cmd/PowerShell and an extensionless one for Git Bash — bash
// appends only .exe to a name and does not read PATHEXT (like npm and npm.cmd).
function writeShims(appDir, nodePath) {
  const target = path.join(env.home(), ".local", "bin");
  const dir = fs.existsSync(target) ? target : path.join(appDir, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(appDir, "src", "cli.js");
  const cmd = path.join(dir, "claude-acct.cmd");
  fs.writeFileSync(cmd, ["@echo off", `"${nodePath}" "${cli}" %*`, ""].join("\r\n"), "utf8");
  const sh = path.join(dir, "claude-acct");
  fs.writeFileSync(
    sh,
    ["#!/bin/sh", `exec "${nodePath.replace(/\\/g, "/")}" "${cli.replace(/\\/g, "/")}" "$@"`, ""].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  return { cmd, sh, dir, onPath: env.onPath(dir) };
}

// Data is for the current Windows user only: the vault files hold tokens.
function hardenDataDir() {
  const dir = env.ensureDataDir();
  try {
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = { wantClicks: true, dryRun: false };
  for (const arg of argv) {
    switch (arg) {
      case "--no-clicks":
        options.wantClicks = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        util.die(`unknown argument '${arg}'\n${USAGE}`);
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (process.platform !== "win32") {
    util.die("this installer is for Windows; on macOS and Linux install the original claude-acct");
  }
  const appDir = path.join(env.dataDir(), "app");
  const staging = `${appDir}.new`;
  const nodePath = process.execPath;

  const previous = settings.readState();
  const currentSettings = util.readJson(env.settingsPath(), {}) || {};
  const currentBrowser = (currentSettings.env && currentSettings.env.BROWSER) || "";
  const originalBrowser =
    (previous.originals && previous.originals.env && previous.originals.env.BROWSER) ||
    previous.shellBrowser ||
    (currentBrowser && !settings.isOurBrowser(currentBrowser) ? currentBrowser : "") ||
    (process.env.BROWSER && !settings.isOurBrowser(process.env.BROWSER) ? process.env.BROWSER : "");

  if (options.dryRun) {
    process.stdout.write(
      [
        "Changing nothing; this is what would be done:",
        `  working copy       → ${appDir}`,
        `  link handler       → ${options.wantClicks ? path.join(appDir, "opener", "claude-acct-opener.exe") : "not installed (--no-clicks)"}`,
        `  compiler           → ${cscPath() || "csc.exe not found — clicks will be off"}`,
        `  settings           → ${env.settingsPath()} (statusLine${options.wantClicks ? " + env.BROWSER" : ""}, your own status line is kept)`,
        `  previous browser   → ${originalBrowser || "not set, links will go to the default browser"}`,
        `  data               → ${env.dataDir()}`,
        "",
      ].join("\n")
    );
    return 0;
  }

  env.ensureDataDir();
  const built = buildStaging(staging, options.wantClicks);
  if (!built.exe && options.wantClicks) {
    util.warn(`${built.why}; installing without clicks (switch with claude-acct use)`);
  }
  swapIn(appDir, staging);
  const openerPath = built.exe ? path.join(appDir, "opener", "claude-acct-opener.exe") : null;
  if (openerPath) {
    writeOpenerConf(appDir, { nodePath, originalBrowser });
  }

  const applied = settings.apply({ appDir, nodePath, openerPath });
  const shims = writeShims(appDir, nodePath);
  const hardened = hardenDataDir();

  process.stdout.write(
    [
      `claude-acct ${env.version()} installed.`,
      `  working copy       ${appDir}`,
      openerPath ? `  link handler       ${openerPath}` : "  link handler       NOT installed — clicks are off",
      `  settings           ${applied.settingsFile}`,
      `  data               ${env.dataDir()}${hardened ? " (only your Windows account can access it)" : ""}`,
      `  command            ${shims.cmd}${shims.onPath ? "" : `  ← ${shims.dir} is not on PATH; add it`}`,
      "",
      "In Claude Code:",
      "  1. Clicking needs fullscreen rendering: run /tui fullscreen if it is not on.",
      "  2. For each of your accounts: /login, then click \"＋ save\" in the status line (or run claude-acct save).",
      "  3. Alt+click an account in the status line to switch to it. Ctrl+click switches too, but Windows Terminal\n     also opens the link itself as an empty browser tab — hence Alt.",
      "  Do not use /logout to switch: it revokes the login, and the saved copy stops working.",
      "",
      "The account row shows up in open sessions too — they re-read the status line by themselves.",
      openerPath
        ? "Clicks, though, only work in sessions started AFTER the install: a session gets environment variables\nfrom settings.json at startup, and they cannot be changed while it runs. In older windows,\nswitch with claude-acct use for now."
        : "Switch with claude-acct use.",
      "",
      "Check the setup with: claude-acct doctor",
      "",
    ].join("\n")
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`claude-acct: ${e instanceof util.CaError ? e.message : e.stack || e}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, cscPath, buildStaging };
