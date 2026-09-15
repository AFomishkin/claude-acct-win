"use strict";
// The link handler. Claude Code opens a clicked link through $BROWSER;
// our opener.exe hands claude-acct.localhost links over to here, and anything else
// goes where it would have gone without us.

const { spawn } = require("child_process");
const accounts = require("./accounts");
const settings = require("./settings");
const statusline = require("./statusline");
const ui = require("./ui");
const usage = require("./usage");
const util = require("./util");
const vault = require("./vault");

const BASE = statusline.URL_BASE;

async function openUrl(url) {
  if (typeof url !== "string" || !url.startsWith(`${BASE}/`)) {
    openElsewhere(url);
    return;
  }
  const route = url
    .slice(BASE.length + 1)
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");

  if (route.startsWith("use/")) {
    const id = route.slice(4);
    if (!vault.validId(id) || id === "__backup__") {
      ui.notify("invalid account link");
      return;
    }
    // Poke the settings before anything else: Claude Code redraws the status line
    // about a second later, and the whole switch fits inside that second.
    process.env.CA_POKED_AT = String(util.nowMs());
    settings.poke();
    try {
      accounts.use(id);
    } catch (e) {
      ui.notify(`switch failed: ${e.message}`);
    }
    return;
  }

  switch (route) {
    case "save":
      try {
        accounts.save();
      } catch (e) {
        ui.notify(`save failed: ${e.message}`);
      }
      return;
    case "refresh": {
      const { problems } = await usage.refresh({});
      settings.poke();
      if (problems.length) {
        ui.notify(`some limits are missing: ${problems.join("; ")}`);
      }
      return;
    }
    case "collapse":
      ui.setCollapsed(true);
      return;
    case "expand":
      ui.setCollapsed(false);
      return;
    case "notice/off":
      ui.clearNotice();
      return;
    default:
      ui.notify(`unknown link: ${route}`);
  }
}

// Not our link: open it the way it would have opened without claude-acct.
function openElsewhere(url) {
  if (typeof url !== "string" || !url) {
    return;
  }
  const state = settings.readState();
  const original =
    (state.originals && state.originals.env && state.originals.env.BROWSER) || state.shellBrowser || "";
  try {
    if (original && !settings.isOurBrowser(original)) {
      spawn(original, [url], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  } catch {
    util.warn(`could not open ${url}`);
  }
}

module.exports = { openUrl, openElsewhere };
