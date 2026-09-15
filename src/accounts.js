"use strict";
// Account commands and the switch itself.

const background = require("./background");
const env = require("./env");
const gconfig = require("./gconfig");
const ratelimits = require("./ratelimits");
const settings = require("./settings");
const store = require("./store");
const util = require("./util");
const vault = require("./vault");

function requireValidBlob(blob) {
  if (!store.oauthValid(blob)) {
    util.die("Claude Code credentials have an unexpected format; nothing was changed (is claude-acct up to date?)");
  }
}

function save({ label = "" } = {}) {
  return util.withLock("lock", () => {
    if (!store.present()) {
      util.die("Claude Code is not logged in; run /login first");
    }
    const blob = store.read();
    if (!blob) {
      util.die("could not read Claude Code credentials");
    }
    requireValidBlob(blob);
    const acct = gconfig.account();
    if (!acct) {
      util.die(`no logged-in account in ${env.globalConfigPath()}; run /login first`);
    }
    const key = gconfig.accountKey(acct);
    const id = gconfig.accountId(key);
    if (!vault.put(id, store.vaultRecord(blob, acct))) {
      util.die("could not store the account");
    }
    if (!vault.indexUpsert(vault.entry(id, key, label, blob, acct))) {
      util.die(`could not update ${vault.indexPath()}`);
    }
    util.log(`save ${id}`);
    settings.poke();
    return { id, label: vault.indexLabel(id) };
  });
}

// What Claude Code holds right now.
function currentState() {
  // A config that does not parse would later get overwritten by us — refuse BEFORE
  // any write, while the credentials are still untouched.
  util.readJsonStrict(env.globalConfigPath(), { what: env.globalConfigPath() });
  const live = store.liveBlob();
  const acct = gconfig.account();
  return {
    live,
    acct: acct || null,
    curId: acct ? gconfig.accountId(gconfig.accountKey(acct)) : "",
  };
}

// Make Claude Code use the account in the record. Only account-bound keys
// change; BOTH writes — the credentials and the config — are verified by
// reading back, and any failure puts everything back as it was.
function applyRecord(live, record, previousAccount) {
  const next = store.merge(live, record);
  const want = (record.claudeAiOauth && record.claudeAiOauth.refreshToken) || "";
  let wrote = false;
  try {
    store.write(next);
    wrote = true;
    const back = store.read();
    const got = (back && back.claudeAiOauth && back.claudeAiOauth.refreshToken) || "";
    if (got !== want) {
      util.warn("the credentials did not read back as written; undoing the switch");
    } else {
      // The config and the store must agree: the background re-save picks the
      // vault slot from the config, so a store holding B under a config naming A
      // would file B's tokens under A. A record without an account is the logged-out state.
      const acct = record.oauthAccount || null;
      if (acct ? gconfig.setAccount(acct) : gconfig.clearAccount()) {
        return true;
      }
      util.warn(`could not update ${env.globalConfigPath()}; undoing the switch`);
    }
  } catch (e) {
    util.warn(`${e.message}; undoing the switch`);
  }
  if (wrote) {
    try {
      store.write(live);
    } catch {
      util.warn("rollback of the credentials failed; run: claude-acct restore");
    }
  }
  // The config may have changed before the failure — put it back too.
  try {
    if (previousAccount) {
      gconfig.setAccount(previousAccount);
    } else if (gconfig.account()) {
      gconfig.clearAccount();
    }
  } catch {
    util.warn(`could not put the account back in ${env.globalConfigPath()}`);
  }
  return false;
}

// The switch itself, shared by use and restore. Expects currentState()
// to have run under the lock already.
function switchTo(state, record, label, pokedAtMs) {
  const overrides = env.overrides();
  if (overrides.length) {
    util.warn(`note: ${overrides.join(",")} takes precedence over the login, so Claude Code keeps using it`);
  }

  // Poke the settings now, not after: Claude Code redraws the status line about a
  // second later, and the switch finishes well within that, so the redraw shows the result.
  // A click has already poked them before even resolving the account.
  let started = pokedAtMs;
  if (!started) {
    started = util.nowMs();
    settings.poke();
  }

  // Refresh tokens rotate while an account is in use: update its saved copy before leaving.
  if (state.curId && vault.indexGet(state.curId) && state.live.claudeAiOauth) {
    if (!vault.put(state.curId, store.vaultRecord(state.live, state.acct))) {
      util.die("could not update the saved copy of the current account; nothing was switched");
    }
  } else if (state.curId) {
    util.warn("the account you are leaving is not saved; to keep it, /login to it and click ＋ save");
  }

  // The backup goes first, so even a failed rollback can still point at it.
  if (!vault.put("__backup__", store.vaultRecord(state.live, state.acct))) {
    util.die("could not write the backup; nothing was switched");
  }
  if (!applyRecord(state.live, record, state.acct)) {
    util.die("switch failed; the previous login is still active");
  }

  ratelimits.update((rl) => {
    rl.switch = { from: state.curId || null, at: util.nowSec() };
    return rl;
  });
  util.log(`switch to ${label} (was ${state.curId || "none"})`);

  // Bookkeeping nothing above depends on: the index entry of the account just left.
  if (state.curId && state.acct && vault.indexGet(state.curId)) {
    vault.indexUpsert(
      vault.entry(state.curId, gconfig.accountKey(state.acct), "", state.live, state.acct)
    );
  }
  // If the status line already drew while the switch was in progress, it showed the
  // old account: poke once more so the next redraw shows the new one.
  if (settings.statuslineRanSince(started)) {
    settings.poke();
  }
  // The new account's limits are fetched in the background and appear at the next tick —
  // the account row already shows what that account reported last time.
  if (process.env.CA_USAGE_SYNC !== "1") {
    background.run(["round", "switch"]);
  }
  return true;
}

function use(query) {
  return util.withLock("lock", () => {
    const id = vault.indexFind(query);
    const saved = vault.get(id);
    if (!saved) {
      util.die(`no saved credentials for ${id}; log in to that account and run: claude-acct save`);
    }
    const state = currentState();
    if (state.curId === id && state.live.claudeAiOauth) {
      return { already: true, label: vault.indexLabel(id), id };
    }
    switchTo(state, saved, `${vault.indexLabel(id)} (${id})`, Number(process.env.CA_POKED_AT) || 0);
    return { already: false, label: vault.indexLabel(id), id };
  });
}

function restore() {
  return util.withLock("lock", () => {
    const backup = vault.get("__backup__");
    if (!backup) {
      util.die("there is no backup yet");
    }
    const state = currentState();
    const who =
      (backup.oauthAccount && backup.oauthAccount.emailAddress) || "the logged-out state";
    // A restore is a switch like any other: it re-saves the account it leaves and
    // writes a new backup, so a second restore goes back again.
    switchTo(state, backup, `${who} (restored)`);
    return { label: who };
  });
}

// Bring the vault copy of the active account up to date with the tokens
// Claude Code is using now: they rotate, and /login to another account
// drops the old ones without telling us.
function syncActive() {
  const acct = gconfig.account();
  if (!acct) {
    return false;
  }
  const id = gconfig.accountId(gconfig.accountKey(acct));
  if (!vault.indexGet(id) || !store.present()) {
    return false;
  }
  const live = store.read();
  if (!live || !store.oauthValid(live)) {
    return false;
  }
  const saved = vault.get(id);
  if (!saved) {
    return false;
  }
  // ★ The live login must belong to the same account the config names.
  // If the two have drifted apart (another session rewrote ~/.claude.json right after us,
  // the process died between the two writes), a blind re-save would file one account's
  // tokens in another's slot — leaving nothing to restore the first one from.
  if (live.organizationUuid && acct.organizationUuid && live.organizationUuid !== acct.organizationUuid) {
    util.warn(
      "the credentials and the logged-in account do not match; the saved copy was left alone (check: claude-acct doctor)"
    );
    return false;
  }
  if (saved.oauthAccount && saved.oauthAccount.accountUuid !== acct.accountUuid) {
    return false;
  }
  const pair = (blob) =>
    `${blob.claudeAiOauth.refreshToken}/${blob.claudeAiOauth.accessToken}`;
  if (!saved.claudeAiOauth || pair(live) === pair(saved)) {
    return false;
  }
  if (!vault.put(id, store.vaultRecord(live, acct))) {
    return false;
  }
  vault.indexUpsert(vault.entry(id, gconfig.accountKey(acct), "", live, acct));
  util.log(`sync ${id}`);
  return true;
}

function list() {
  const active = gconfig.activeId();
  const index = vault.indexRead();
  if (!index.accounts.length) {
    return "No saved accounts yet. Log in with /login, then run: claude-acct save";
  }
  return index.accounts
    .map((a) => {
      const mark = a.id === active ? "*" : " ";
      const plan = a.plan || "?";
      const until = a.loginExpiresAt
        ? `, login until ${new Date(a.loginExpiresAt).toISOString().slice(0, 10)}`
        : "";
      return `${mark} ${a.id}  ${a.label}  [${plan}${until}]`;
    })
    .join("\n");
}

function rename(query, label) {
  return util.withLock("lock", () => {
    if (!label) {
      util.die("usage: claude-acct rename <account> <label>");
    }
    const id = vault.indexFind(query);
    const index = vault.indexRead();
    index.accounts = index.accounts.map((a) =>
      // eslint-disable-next-line no-control-regex
      a.id === id ? { ...a, label: label.replace(/[\x00-\x1f\x7f]/g, "") } : a
    );
    vault.indexWrite(index);
    settings.poke();
    return { id, label: vault.indexLabel(id) };
  });
}

function remove(query) {
  return util.withLock("lock", () => {
    const id = vault.indexFind(query);
    vault.del(id);
    vault.indexRemove(id);
    ratelimits.remove(id);
    util.log(`rm ${id}`);
    settings.poke();
    return { id };
  });
}

module.exports = {
  save,
  currentState,
  applyRecord,
  switchTo,
  use,
  restore,
  syncActive,
  list,
  rename,
  remove,
};
