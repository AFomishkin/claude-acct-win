"use strict";
// Claude Code's credentials. On Windows they are always the .credentials.json file
// (there is no Keychain as on macOS): it holds the claude.ai login, MCP logins
// and plugin secrets alike — we touch only what belongs to the account.

const fs = require("fs");
const env = require("./env");
const util = require("./util");

// Keys that Claude Code drops when /login switches accounts. Everything
// else (mcpOAuth, pluginSecrets and the like) belongs to the machine, not the login.
const BOUND_KEYS = ["claudeAiOauth", "designOauth", "trustedDeviceToken", "organizationUuid"];

function present() {
  return fs.existsSync(env.credentialsFile());
}

function read() {
  const blob = util.readJson(env.credentialsFile(), null);
  if (blob === null || typeof blob !== "object" || Array.isArray(blob)) {
    return null;
  }
  return blob;
}

function write(blob) {
  util.writeJsonAtomic(env.credentialsFile(), blob);
}

// Does it have the shape claude-acct relies on?
function oauthValid(blob) {
  const o = blob && blob.claudeAiOauth;
  return Boolean(
    o &&
      typeof o === "object" &&
      typeof o.accessToken === "string" &&
      typeof o.refreshToken === "string" &&
      typeof o.expiresAt === "number" &&
      Array.isArray(o.scopes)
  );
}

// The live blob: {} when not logged in; fails when there is one but it cannot be read.
function liveBlob() {
  if (!present()) {
    return {};
  }
  const blob = read();
  if (blob === null) {
    util.die("could not read Claude Code credentials; nothing was changed");
  }
  if (Object.prototype.hasOwnProperty.call(blob, "claudeAiOauth") && !oauthValid(blob)) {
    util.die("Claude Code credentials have an unexpected format; nothing was changed (is claude-acct up to date?)");
  }
  return blob;
}

// What the vault keeps for an account: only its keys plus its oauthAccount.
function vaultRecord(blob, account) {
  const record = {};
  for (const key of BOUND_KEYS) {
    if (Object.prototype.hasOwnProperty.call(blob, key)) {
      record[key] = blob[key];
    }
  }
  record.oauthAccount = account;
  return record;
}

// Merge the live blob with an account's record: other keys stay, the account's keys come from the record.
function merge(live, record) {
  const next = {};
  for (const [key, value] of Object.entries(live)) {
    if (!BOUND_KEYS.includes(key)) {
      next[key] = value;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== "oauthAccount") {
      next[key] = value;
    }
  }
  return next;
}

module.exports = { BOUND_KEYS, present, read, write, oauthValid, liveBlob, vaultRecord, merge };
