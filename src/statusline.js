"use strict";
// The status line: the user's own status line first, then the account row and
// the controls. Claude Code runs this often, so it spawns no process it can
// avoid: everything is worked out in place, and the network goes to the background.

const { spawnSync } = require("child_process");
const background = require("./background");
const env = require("./env");
const gconfig = require("./gconfig");
const ratelimits = require("./ratelimits");
const settings = require("./settings");
const ui = require("./ui");
const usage = require("./usage");
const util = require("./util");
const vault = require("./vault");

const URL_BASE = "http://claude-acct.localhost";
const ORANGE_RGB = "38;2;217;119;87"; // the Anthropic orange
const ORANGE_256 = "38;5;173"; // closest xterm-256 colour, for terminals without truecolor
const ESC = "\x1b";
const BEL = "\x07";
const NOTICE_SECONDS = 120;

function style(kind) {
  if (process.env.NO_COLOR || process.env.TERM === "dumb") {
    return "";
  }
  if (kind === "off") {
    return `${ESC}[0m`;
  }
  const colorterm = process.env.COLORTERM;
  const color = colorterm === "truecolor" || colorterm === "24bit" ? ORANGE_RGB : ORANGE_256;
  return `${ESC}[1;${color}m`;
}

// OSC 8 hyperlink: ESC ] 8 ; ; url BEL text ESC ] 8 ; ; BEL
function link(url, text) {
  return `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`;
}

function dur(seconds) {
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

// A window with no resets_at has not started yet, so its 0% is true, with no countdown.
// One whose reset has passed is stale: better to show nothing than a wrong number.
function windowText(name, w, now) {
  if (!w || typeof w !== "object" || typeof w.used_percentage !== "number") {
    return null;
  }
  // The reset time counts only as a number: a string or junk is shown honestly as
  // a window with no countdown, not as "↻NaNd".
  const resets = typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : null;
  if (resets !== null && resets <= now) {
    return null;
  }
  const head = `${name} ${Math.floor(w.used_percentage)}%`;
  return resets === null ? head : `${head}↻${dur(resets - now)}`;
}

function limitsText(src, now) {
  if (!src || typeof src !== "object") {
    return "";
  }
  if (typeof src.fetchedAt === "number" && now - src.fetchedAt > ratelimits.STALE_SECONDS) {
    return " ?"; // last heard from too long ago to be true
  }
  const parts = [windowText("5h", src.five_hour, now), windowText("7d", src.seven_day, now)].filter(Boolean);
  return parts.length ? ` ${parts.join(" · ")}` : "";
}

// The same reset time a second apart: the session and the endpoint round it differently.
function near(a, b) {
  return Math.abs(a - b) <= 5;
}

// A window is known by its reset time, which does not move while the window runs.
function running(w, now) {
  return Boolean(w && typeof w === "object" && typeof w.resets_at === "number" && w.resets_at > now);
}

// At least one window runs on both sides, and every window that does resets at the same time.
function sameWindows(a, b, now) {
  const shared = ["five_hour", "seven_day"].filter((k) => running(a && a[k], now) && running(b && b[k], now));
  return shared.length > 0 && shared.every((k) => near(a[k].resets_at, b[k].resets_at));
}

// A fingerprint of the session's numbers. Percentages are floored: only whole ones
// are shown anyway, while the raw fractions differ between a dozen open sessions and
// would make each redraw rewrite the shared file.
function signature(lim) {
  const five = lim.five_hour || {};
  const seven = lim.seven_day || {};
  const value = (v) => (v === null || v === undefined ? "" : typeof v === "number" ? Math.floor(v) : v);
  return `${value(five.resets_at)}|${value(five.used_percentage)}|${value(seven.resets_at)}|${value(seven.used_percentage)}`;
}

// The session only reports the active account's limits, and after a switch it keeps
// showing the numbers of the account it last got a response for, which can be several
// switches back; another open session can show still older numbers of that account.
// Such leftovers are told apart by what the other accounts are known to have: the
// numbers the previous account last showed, or a window of any other account (its last
// numbers may have gone unrecorded, but its windows do not move). A window that has
// reset since tells nothing either way. Reset times are rounded (minutes for 5h, the
// hour for 7d), so two accounts started close together can coincide; the new account's
// numbers then stay unrecorded until the windows part, and the row shows the endpoint's
// numbers meanwhile. Same rule as upstream 9603b09.
// The previous account is the one a switch left, or the one the last status line saw
// active: a /login by hand is a switch too.
function observe({ active, lim, rl, now }) {
  if (!active || !lim || typeof lim !== "object") {
    return { status: "none", entry: null };
  }
  const sig = signature(lim);
  const prevs = [rl.switch && rl.switch.from, rl.lastActive].filter((id) => id && id !== active);
  const previousNumbers = prevs.some((id) => sig === ((rl.accounts[id] || {}).lastSig || ""));
  const otherWindows = Object.entries(rl.accounts).some(
    ([id, known]) => id !== active && sameWindows(lim, known, now)
  );
  if (previousNumbers || otherWindows) {
    return { status: "stale", entry: null };
  }
  if ((rl.accounts[active] && rl.accounts[active].lastSig) === sig) {
    return { status: "live", entry: null };
  }
  return {
    status: "live",
    entry: {
      five_hour: lim.five_hour || null,
      seven_day: lim.seven_day || null,
      observedAt: now,
      fetchedAt: now,
      source: "session",
      lastSig: sig,
    },
  };
}

// The terminal width comes in COLUMNS: Claude Code puts COLUMNS/LINES into the
// status line command's environment (probed in Windows Terminal: 120/30). Our stdout
// is a pipe, so there is no other source. Without it, CLAUDE_ACCT_COLUMNS is used,
// and without that nothing is shortened: the row collapses only by the "⤡ collapse" link.
function columns() {
  for (const raw of [process.env.COLUMNS, process.env.CLAUDE_ACCT_COLUMNS]) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

// Splits a simple command like `node C:/path/bar.js --flag` (with quotes around
// paths with spaces). It lets the user's own status line run WITHOUT a shell:
// otherwise the timeout guards only cmd.exe, while the real script holds the pipe
// for as long as it likes — and the status line hangs along with it.
function parseCommand(command) {
  if (/[|&<>^%!`$]/.test(command)) {
    return null; // there is something for the shell to act on — let the shell parse it
  }
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (!parts.length) {
    return null;
  }
  const args = parts.map((p) => (/^["'].*["']$/.test(p) ? p.slice(1, -1) : p));
  return { file: args[0], args: args.slice(1) };
}

const ORIGINAL_TIMEOUT_MS = 3000;
const ORIGINAL_MAX_BYTES = 64 * 1024;

// The user's own status line: its output goes on the first line, as it did before us.
function originalRow(input) {
  const state = settings.readState();
  const original = state.originals && state.originals.statusLine;
  if (!original || original.type !== "command" || typeof original.command !== "string") {
    return null;
  }
  if (settings.isOurStatusLine(original)) {
    return null;
  }
  const options = {
    input: `${input}\n`,
    encoding: "utf8",
    timeout: ORIGINAL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: ORIGINAL_MAX_BYTES,
  };
  try {
    const simple = parseCommand(original.command);
    const result = simple
      ? spawnSync(simple.file, simple.args, options)
      : spawnSync(original.command, { ...options, shell: true });
    if (result.error) {
      util.log(`the user's own status line: ${result.error.message}`);
      return null;
    }
    const out = (result.stdout || "").slice(0, ORIGINAL_MAX_BYTES).replace(/\s+$/, "");
    return out || null;
  } catch {
    return null;
  }
}

function render(input) {
  const now = util.nowSec();
  settings.markStatuslineRun();

  const index = vault.indexRead();
  const rl = ratelimits.read();
  const state = ui.read();
  const account = gconfig.account();
  const key = account ? gconfig.accountKey(account) : null;
  const active = key ? (index.accounts.find((a) => a.key === key) || {}).id || null : null;

  let session = {};
  try {
    session = JSON.parse(input);
  } catch {
    session = {}; // broken input is no reason not to draw the row
  }
  const lim = session && typeof session === "object" ? session.rate_limits || null : null;

  const obs = observe({ active, lim, rl, now });
  const patch =
    obs.entry || (active && active !== rl.lastActive)
      ? { entry: obs.entry, lastActive: active !== rl.lastActive ? active : null }
      : null;
  const known = obs.entry
    ? { ...rl, accounts: { ...rl.accounts, [active]: { ...(rl.accounts[active] || {}), ...obs.entry } } }
    : rl;

  const rows = [];
  // The user's own status line comes first, as before.
  const own = originalRow(input);
  if (own) {
    rows.push(own);
  }

  if (key) {
    const accounts = index.accounts.map((a) => ({
      ...a,
      isActive: a.id === active,
      src: a.id === active && obs.status === "live" ? lim : known.accounts[a.id],
    }));
    const controlsPlain = [];
    const controlsStyled = [];
    const addControl = (url, text) => {
      controlsPlain.push(text);
      controlsStyled.push(link(url, text));
    };

    const accountRow = (short) => {
      const plain = [];
      const styled = [];
      for (const a of accounts) {
        const name = short ? `${a.label.slice(0, 3)}…` : a.label;
        const body = `${name}${limitsText(a.src, now)}`;
        plain.push(`${a.isActive ? "● " : ""}${body}`);
        styled.push(
          a.isActive
            ? `${style("active")}● ${link(`${URL_BASE}/use/${a.id}`, body)}${style("off")}`
            : link(`${URL_BASE}/use/${a.id}`, body)
        );
      }
      return { plain: plain.join("  │  "), styled: styled.join("  │  ") };
    };

    if (!active) {
      addControl(`${URL_BASE}/save`, "＋ save");
    }
    addControl(`${URL_BASE}/refresh`, "↻ limits");

    // Names are shortened only when the full row does not fit; two columns of headroom
    // keep it clear of the edge, and 0 means the width is unknown.
    const width = columns();
    const tail = `   ${controlsPlain.join("  ")}`;
    let short;
    if (state.collapsed === true) {
      short = true;
    } else if (state.collapsed === false) {
      short = false;
    } else {
      short = width > 0 && accountRow(false).plain.length + tail.length + 12 > width - 2;
    }
    const collapseUrl = short ? `${URL_BASE}/expand` : `${URL_BASE}/collapse`;
    const collapseText = short ? "⤢ expand" : "⤡ collapse";
    const row = accountRow(short);
    const controls = `${link(collapseUrl, collapseText)}  ${controlsStyled.join("  ")}`;
    // There may be no saved accounts yet — then the row starts right with the controls.
    rows.push(row.styled ? `${row.styled}   ${controls}` : controls);

    // A failure message (a switch did not go through, limits could not be had) goes on
    // a third row, and not for long: a terminal has no pop-up notifications.
    if (state.notice && state.notice.text && now - (state.notice.at || 0) < NOTICE_SECONDS) {
      rows.push(`⚠ ${state.notice.text}   ${link(`${URL_BASE}/notice/off`, "✕ hide")}`);
    }
  }

  return { text: rows.join("\n"), patch, active, due: now - ((rl.auto && rl.auto.at) || 0) >= usage.AUTO_SECONDS };
}

// The background round: the limits of every account and a fresh copy of the active one's tokens.
// Runs at most once every AUTO_SECONDS, and from one session only (whichever took the lock).
function maybeRefresh() {
  const now = util.nowSec();
  if (now - ((ratelimits.read().auto || {}).at || 0) < usage.AUTO_SECONDS) {
    return;
  }
  // The slot is claimed atomically: the "is it free" check and the write happen under
  // one file lock, and only the one whose write went through starts the round.
  // A dozen sessions draw at the same moment — otherwise there would be as many rounds.
  const claimed = ratelimits.update((state) => {
    if (now - ((state.auto && state.auto.at) || 0) < usage.AUTO_SECONDS) {
      return false;
    }
    state.auto = { at: now };
    return state;
  });
  if (!claimed) {
    return;
  }
  background.run(["round", "auto"]);
}

function run(input) {
  const result = render(input);
  if (result.text) {
    process.stdout.write(`${result.text}\n`);
  }
  if (result.patch && result.active) {
    ratelimits.update((state) => {
      if (result.patch.entry) {
        state.accounts[result.active] = { ...(state.accounts[result.active] || {}), ...result.patch.entry };
      }
      if (result.patch.lastActive) {
        state.lastActive = result.patch.lastActive;
      }
      return state;
    });
  }
  // Keep the numbers current even while the user is just waiting for a limit reset.
  if (result.due) {
    maybeRefresh();
  }
}

module.exports = { URL_BASE, run, render, observe, limitsText, windowText, dur, near, signature, link, style };
