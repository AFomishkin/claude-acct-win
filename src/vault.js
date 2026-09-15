"use strict";
// Saved accounts: secrets go to vault\<id>.json, and accounts.json
// indexes them without secrets (what the status line shows and how to find an account).

const fs = require("fs");
const path = require("path");
const env = require("./env");
const util = require("./util");

const ID_RE = /^([0-9a-f]{8}|__backup__)$/;

function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function vaultDir() {
  return path.join(env.dataDir(), "vault");
}

function vaultFile(id) {
  return path.join(vaultDir(), `${id}.json`);
}

// Returns false instead of throwing: callers check the result and decide
// whether to go on with the switch.
function put(id, record) {
  if (!validId(id)) {
    return false;
  }
  try {
    fs.mkdirSync(vaultDir(), { recursive: true });
    util.writeJsonAtomic(vaultFile(id), record);
    return true;
  } catch (e) {
    util.warn(`could not write ${vaultFile(id)}: ${e.message}`);
    return false;
  }
}

function get(id) {
  if (!validId(id)) {
    return null;
  }
  return util.readJson(vaultFile(id), null);
}

function del(id) {
  if (!validId(id)) {
    return;
  }
  try {
    fs.unlinkSync(vaultFile(id));
  } catch {
    /* already gone — fine */
  }
}

function indexPath() {
  return path.join(env.dataDir(), "accounts.json");
}

// Strictly: we rewrite the index whole, so "does not parse" must not
// turn into "no accounts" — or a single edit would wipe the list.
function indexRead() {
  const value = util.readJsonStrict(indexPath(), { what: indexPath() });
  if (value === null) {
    return { accounts: [] };
  }
  if (typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.accounts)) {
    util.die(`${indexPath()} is not a list of accounts; nothing was changed`);
  }
  return value;
}

function indexWrite(index) {
  try {
    env.ensureDataDir();
    util.writeJsonAtomic(indexPath(), index);
    return true;
  } catch (e) {
    util.warn(`could not write ${indexPath()}: ${e.message}`);
    return false;
  }
}

function entry(id, key, label, blob, account) {
  const o = (blob && blob.claudeAiOauth) || {};
  return {
    id,
    key,
    label,
    email: account.emailAddress || "",
    orgName: account.organizationName || "",
    plan: o.subscriptionType || "",
    loginExpiresAt: o.refreshTokenExpiresAt ?? null,
    savedAt: new Date().toISOString(),
  };
}

// Add or update by id. An empty label keeps the current one; a new account is
// labelled with its email, or "email (organization)" if that email is taken.
function indexUpsert(next) {
  const index = indexRead();
  const old = index.accounts.find((a) => a.id === next.id) || null;
  const duplicate = index.accounts.some((a) => a.id !== next.id && a.email === next.email);
  let label = next.label || "";
  if (!label) {
    if (old) {
      label = old.label;
    } else if (duplicate) {
      label = `${next.email} (${next.orgName})`;
    } else {
      label = next.email;
    }
  }
  // eslint-disable-next-line no-control-regex
  const clean = { ...next, label: String(label).replace(/[\x00-\x1f\x7f]/g, "") };
  if (old) {
    index.accounts = index.accounts.map((a) => (a.id === next.id ? clean : a));
  } else {
    index.accounts.push(clean);
  }
  return indexWrite(index);
}

function indexRemove(id) {
  const index = indexRead();
  index.accounts = index.accounts.filter((a) => a.id !== id);
  return indexWrite(index);
}

function indexGet(id) {
  return indexRead().accounts.find((a) => a.id === id) || null;
}

function indexLabel(id) {
  const found = indexGet(id);
  return found ? found.label : id;
}

// Find by id, label or email: exactly one match, otherwise a clear refusal.
function indexFind(query) {
  const accounts = indexRead().accounts;
  const byId = accounts.filter((a) => a.id === query);
  const byLabel = accounts.filter((a) => a.label === query);
  const byEmail = accounts.filter((a) => a.email === query);
  const matches = byId.length ? byId : byLabel.length ? byLabel : byEmail;
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length === 0) {
    util.die(`no saved account matches '${query}' (see: claude-acct list)`);
  }
  util.die(`'${query}' matches several accounts; use its id (see: claude-acct list)`);
}

module.exports = {
  validId,
  vaultDir,
  put,
  get,
  del,
  indexPath,
  indexRead,
  indexWrite,
  entry,
  indexUpsert,
  indexRemove,
  indexGet,
  indexLabel,
  indexFind,
};
