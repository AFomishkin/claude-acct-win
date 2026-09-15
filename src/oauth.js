"use strict";
// Renewing a saved account's login.
//
// Access tokens last a few hours. Claude Code renews the active account's by
// itself; a saved account nobody has switched to for a while ends up expired, and
// the usage endpoint no longer accepts it. This uses the same token endpoint and
// the same client id Claude Code uses, with the account's own refresh token.
// The new tokens are filed in the vault BEFORE anything uses them.
// The active account is never touched here — it belongs to Claude Code.

const gconfig = require("./gconfig");
const http = require("./http");
const env = require("./env");
const util = require("./util");
const vault = require("./vault");
const ratelimits = require("./ratelimits");

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TIMEOUT_MS = 8000;
const BACKOFF_SECONDS = 900; // a throttled login is left alone: asking again only prolongs the refusal

function expired(record) {
  const at = (record && record.claudeAiOauth && record.claudeAiOauth.expiresAt) || 0;
  return at / 1000 < util.nowSec() + 60;
}

// renew(record) -> {ok: true, record} | {ok: false, why}
// why: invalid_grant | throttled | unreachable | unexpected
async function renew(record) {
  const o = record && record.claudeAiOauth;
  if (!o || typeof o.refreshToken !== "string") {
    return { ok: false, why: "unexpected" };
  }
  const payload = {
    grant_type: "refresh_token",
    refresh_token: o.refreshToken,
    client_id: o.clientId || CLIENT_ID,
  };
  const scope = Array.isArray(o.scopes) ? o.scopes.join(" ") : "";
  if (scope) {
    payload.scope = scope;
  }
  let reply;
  try {
    reply = await http.request(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": env.userAgent(),
      },
      body: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    return { ok: false, why: "unreachable" };
  }
  if (reply.status === 429) {
    return { ok: false, why: "throttled" };
  }
  if (reply.status === 400 || reply.status === 401) {
    const body = http.json(reply.body);
    const kind = body && (body.error === "invalid_grant" || (body.error && body.error.type === "invalid_grant"));
    return { ok: false, why: kind ? "invalid_grant" : "unexpected" };
  }
  if (reply.status !== 200) {
    return { ok: false, why: "unreachable" };
  }
  const r = http.json(reply.body);
  if (!r || typeof r.access_token !== "string" || typeof r.expires_in !== "number") {
    return { ok: false, why: "unexpected" };
  }
  const now = util.nowSec();
  const next = JSON.parse(JSON.stringify(record));
  next.claudeAiOauth = {
    ...next.claudeAiOauth,
    accessToken: r.access_token,
    refreshToken: r.refresh_token || next.claudeAiOauth.refreshToken,
    expiresAt: (now + r.expires_in) * 1000,
    scopes:
      typeof r.scope === "string" && r.scope !== "" ? r.scope.split(" ") : next.claudeAiOauth.scopes,
  };
  if (typeof r.refresh_token_expires_in === "number") {
    next.claudeAiOauth.refreshTokenExpiresAt = (now + r.refresh_token_expires_in) * 1000;
  }
  return { ok: true, record: next };
}

// renewVault(id) -> null on success, the failure word otherwise. Under the command lock,
// so two background rounds cannot both spend the same refresh token.
async function renewVault(id) {
  if (process.env.CLAUDE_ACCT_TOKEN_REFRESH === "0") {
    return "disabled";
  }
  if (id === gconfig.activeId()) {
    return "active";
  }
  const rl = ratelimits.read();
  const renewAfter = (rl.accounts[id] && rl.accounts[id].renewAfter) || 0;
  if (renewAfter > util.nowSec()) {
    return "throttled";
  }

  const lock = util.acquireLock("lock", { tries: 300 });
  try {
    // While we waited for the lock, the account may have become active (someone
    // clicked it in the status line) — its login then belongs to Claude Code, not us.
    if (id === gconfig.activeId()) {
      return "active";
    }
    const record = vault.get(id);
    if (!record) {
      return "unexpected";
    }
    if (!expired(record)) {
      return null; // someone else renewed it while we waited for the lock
    }
    const result = await renew(record);
    if (!result.ok) {
      if (result.why === "throttled") {
        ratelimits.update((state) => {
          state.accounts[id] = { ...(state.accounts[id] || {}), renewAfter: util.nowSec() + BACKOFF_SECONDS };
          return state;
        });
      }
      return result.why;
    }
    // Into the vault first: the old refresh token may already be spent.
    if (!vault.put(id, result.record)) {
      return "unexpected";
    }
    const known = vault.indexGet(id);
    vault.indexUpsert(
      vault.entry(id, known ? known.key : "", "", result.record, result.record.oauthAccount || {})
    );
    util.log(`token renewed ${id}`);
    return null;
  } finally {
    lock.release();
  }
}

module.exports = { TOKEN_URL, CLIENT_ID, expired, renew, renewVault };
