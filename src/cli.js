#!/usr/bin/env node
"use strict";
// claude-acct: switch Claude Code between your own saved logins.

const accounts = require("./accounts");
const doctor = require("./doctor");
const env = require("./env");
const settings = require("./settings");
const statusline = require("./statusline");
const usage = require("./usage");
const url = require("./url");
const util = require("./util");
const vault = require("./vault");

const USAGE = `Usage: claude-acct <command>

  save [--label LABEL]      save the account Claude Code is logged in as
  use <account>             switch Claude Code to a saved account (id, label or email)
  list                      show saved accounts (* = active)
  rename <account> <label>  change the label shown in the status line
  rm <account>              forget a saved account
  restore                   undo the last switch
  refresh [account ...]     ask Anthropic for the current limits
  doctor                    check the setup
  uninstall [--purge]       remove claude-acct (--purge also deletes saved accounts)
  version

In Claude Code with fullscreen rendering, Alt+click an account in the status line to switch.`;

function readStdin() {
  const fs = require("fs");
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main(argv) {
  const cmd = argv[0] || "help";
  const rest = argv.slice(1);

  switch (cmd) {
    case "save": {
      let label = "";
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--label") {
          label = rest[++i] || util.die("--label needs a value");
        } else {
          util.die("usage: claude-acct save [--label LABEL]");
        }
      }
      const saved = accounts.save({ label });
      process.stdout.write(`Saved ${saved.label} (${saved.id})\n`);
      return 0;
    }
    case "use": {
      if (rest.length !== 1) {
        util.die("usage: claude-acct use <account>");
      }
      const result = accounts.use(rest[0]);
      process.stdout.write(
        result.already
          ? `Already using ${result.label} (${result.id})\n`
          : `Switched to ${result.label} (${result.id})\n`
      );
      return 0;
    }
    case "list":
    case "ls":
      process.stdout.write(`${accounts.list()}\n`);
      return 0;
    case "rename": {
      if (rest.length !== 2) {
        util.die("usage: claude-acct rename <account> <label>");
      }
      const renamed = accounts.rename(rest[0], rest[1]);
      process.stdout.write(`Renamed ${renamed.id} to ${renamed.label}\n`);
      return 0;
    }
    case "rm":
    case "remove": {
      if (rest.length !== 1) {
        util.die("usage: claude-acct rm <account>");
      }
      process.stdout.write(`Removed ${accounts.remove(rest[0]).id}\n`);
      return 0;
    }
    case "restore": {
      const restored = accounts.restore();
      process.stdout.write(`Restored ${restored.label}\n`);
      return 0;
    }
    case "refresh": {
      const ids = rest.map((q) => vault.indexFind(q));
      env.ensureDataDir();
      const { problems } = await usage.refresh({ ids });
      settings.poke();
      if (problems.length) {
        process.stderr.write(`${problems.join("\n")}\n`);
      }
      process.stdout.write(`${accounts.list()}\n`);
      return problems.length ? 1 : 0;
    }
    case "doctor":
      return doctor.run() ? 0 : 1;
    case "statusline":
      // Drawing must never take the session down: stay silent and draw nothing.
      try {
        statusline.run(readStdin());
      } catch {
        /* nothing */
      }
      return 0;
    case "round": {
      // The background work, in a process of its own; nothing to call by hand.
      const kind = rest[0];
      if (kind === "switch") {
        await usage.refresh({ maxAgeSec: usage.FRESH_SECONDS });
      } else if (kind === "auto") {
        if (process.env.CLAUDE_ACCT_AUTO_REFRESH !== "0") {
          const { stored } = await usage.refresh({});
          if (stored) {
            settings.poke();
          }
        }
        util.withLock("lock", () => accounts.syncActive());
      } else {
        util.die("usage: claude-acct round auto|switch");
      }
      return 0;
    }
    case "open-url":
      await url.openUrl(rest[0]);
      return 0;
    case "uninstall":
      return require("./uninstall").run(rest);
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${env.version()}\n`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e instanceof util.CaError) {
        process.stderr.write(`claude-acct: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`claude-acct: unexpected error: ${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main };
