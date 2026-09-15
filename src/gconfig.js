"use strict";
// oauthAccount in Claude Code's global config (~/.claude.json): who is logged in.

const env = require("./env");
const util = require("./util");

function account() {
  const config = util.readJson(env.globalConfigPath(), null);
  const acct = config && config.oauthAccount;
  if (
    acct &&
    typeof acct === "object" &&
    typeof acct.accountUuid === "string" &&
    typeof acct.organizationUuid === "string"
  ) {
    return acct;
  }
  return null;
}

function accountKey(acct) {
  return `${acct.accountUuid}:${acct.organizationUuid}`;
}

function accountId(key) {
  return util.sha256hex(key).slice(0, 8);
}

function activeId() {
  const acct = account();
  return acct ? accountId(accountKey(acct)) : null;
}

// Claude Code sessions rewrite this config too, so read, change and write it
// in one go, atomically: at worst we lose someone else's change from the same second.
//
// ★ Read strictly. This file holds the whole project history, folder trust,
// MCP servers; taking it for empty when it does not parse (a half-done write by a
// parallel session, a hand edit) would wipe all of that and report
// success. The original fails here through jq — and so do we.
function patchConfig(fn) {
  const file = env.globalConfigPath();
  const config = util.readJsonStrict(file, { what: file });
  if (config !== null && (typeof config !== "object" || Array.isArray(config))) {
    util.die(`${file} is not a JSON object; nothing was changed`);
  }
  const next = fn(config === null ? {} : config);
  util.writeJsonAtomic(file, next);
}

// The write is verified by reading it back: success means the file really holds this
// account, not merely that the call did not throw.
function setAccount(acct) {
  patchConfig((config) => {
    config.oauthAccount = acct;
    return config;
  });
  const back = account();
  return Boolean(
    back && back.accountUuid === acct.accountUuid && back.organizationUuid === acct.organizationUuid
  );
}

function clearAccount() {
  patchConfig((config) => {
    delete config.oauthAccount;
    return config;
  });
  return account() === null;
}

module.exports = { account, accountKey, accountId, activeId, setAccount, clearAccount };
