"use strict";
// The state of the row itself: whether it is collapsed, and what to tell the user
// when something failed (a terminal has no pop-up notifications, so the message
// is shown as a row in the status line).

const path = require("path");
const env = require("./env");
const settings = require("./settings");
const util = require("./util");

function uiPath() {
  return path.join(env.dataDir(), "ui.json");
}

function read() {
  const value = util.readJson(uiPath(), {});
  return value && typeof value === "object" ? value : {};
}

// Read, change and write under a lock: both clicks and error messages from background
// processes change this file, and each write replaces it whole.
function change(fn) {
  const lock = util.tryLock("ui.lock", 60_000, { tries: 40, waitMs: 25 });
  try {
    const state = read();
    const next = fn(state) || state;
    env.ensureDataDir();
    util.writeJsonAtomic(uiPath(), next);
  } catch (e) {
    util.warn(`could not write ${uiPath()}: ${e.message}`);
    return;
  } finally {
    if (lock) {
      lock.release();
    }
  }
  settings.poke();
}

function setCollapsed(value) {
  change((state) => {
    state.collapsed = value;
    return state;
  });
}

function notify(text) {
  change((state) => {
    state.notice = { text: String(text).replace(/\s+/g, " ").slice(0, 200), at: util.nowSec() };
    return state;
  });
}

function clearNotice() {
  change((state) => {
    delete state.notice;
    return state;
  });
}

module.exports = { uiPath, read, change, setCollapsed, notify, clearNotice };
