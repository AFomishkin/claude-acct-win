"use strict";
// claude-acct uninstall [--purge]: put the settings back as they were and remove the working copy.

const fs = require("fs");
const path = require("path");
const env = require("./env");
const settings = require("./settings");
const util = require("./util");
const vault = require("./vault");

function run(args) {
  const purge = args.includes("--purge");
  if (args.some((a) => a !== "--purge")) {
    util.die("usage: claude-acct uninstall [--purge]");
  }
  const state = settings.readState();
  const reverted = settings.revert();
  if (!reverted) {
    // install.json is the only record of what was there before us, and backup/
    // holds the only copies of the previous settings.json. Until the rollback
    // succeeds, none of it is deleted.
    const backups = path.join(env.dataDir(), "backup");
    util.die(
      [
        `could not restore ${env.settingsPath()} — nothing was deleted.`,
        "Fix the file (most likely it does not parse as JSON) and try again.",
        fs.existsSync(backups) ? `Copies of the previous settings: ${backups}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  for (const name of ["claude-acct.cmd", "claude-acct"]) {
    fs.rmSync(path.join(env.home(), ".local", "bin", name), { force: true });
  }

  const appDir = path.join(env.dataDir(), "app");
  const keptOpener = Boolean(state.openerPath) && !purge;
  if (purge) {
    for (const account of vault.indexRead().accounts) {
      vault.del(account.id);
    }
    vault.del("__backup__");
    fs.rmSync(env.dataDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else {
    // The link handler stays: Claude Code sessions that are already open hold its
    // path in their environment and call it until restarted — and even after
    // uninstalling it still opens ordinary links in the browser.
    for (const name of fs.existsSync(appDir) ? fs.readdirSync(appDir) : []) {
      if (keptOpener && name === "opener") {
        continue;
      }
      fs.rmSync(path.join(appDir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    if (!keptOpener) {
      fs.rmSync(appDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    fs.rmSync(settings.installStatePath(), { force: true });
  }

  process.stdout.write(
    [
      "claude-acct removed.",
      purge ? "Saved accounts and backups were deleted." : "Saved accounts were kept; run with --purge to delete them.",
      keptOpener
        ? `The link handler was left in ${path.join(appDir, "opener")}: sessions that are already open call it until restarted,\nand it opens ordinary links in the browser. Once the windows are restarted it can be deleted.`
        : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
  return 0;
}

module.exports = { run };
