"use strict";
// Background work as a process of its own: the status line never waits on the network,
// and no console windows flash meanwhile (detached + windowsHide).

const path = require("path");
const { spawn } = require("child_process");

function cliPath() {
  return path.join(__dirname, "cli.js");
}

function run(args) {
  if (process.env.CA_NO_BACKGROUND === "1") {
    return false; // tests and debugging: no background processes
  }
  try {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      // The working directory is not the app directory: otherwise a background process
      // that lives for tens of seconds holds it, and an update cannot rename it.
      cwd: require("./env").dataDir(),
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { run, cliPath };
