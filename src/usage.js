"use strict";
// Real limits for every saved account.
//
// Claude Code reports limits only for the account it is logged in as, and
// only after that session's first response. The same numbers come from the
// endpoint Claude Code itself calls, which answers for whichever account's token
// is presented — so one read-only GET per account fills in the whole row. No
// prompt is sent and no quota is consumed.

const env = require("./env");
const gconfig = require("./gconfig");
const http = require("./http");
const oauth = require("./oauth");
const ratelimits = require("./ratelimits");
const store = require("./store");
const util = require("./util");
const vault = require("./vault");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
const TIMEOUT_MS = 8000;
const FRESH_SECONDS = 60; // a switch reuses an answer no older than this
const AUTO_SECONDS = 300; // Claude Code's own cache for these numbers lasts this long too

function normalizeWindow(w) {
  if (!w || typeof w !== "object" || typeof w.utilization !== "number") {
    return null;
  }
  let resets = null;
  if (typeof w.resets_at === "string") {
    const ms = Date.parse(w.resets_at);
    if (Number.isFinite(ms)) {
      resets = Math.floor(ms / 1000);
    }
  } else if (typeof w.resets_at === "number") {
    resets = w.resets_at;
  }
  return { used_percentage: Math.floor(w.utilization), resets_at: resets };
}

function normalize(body) {
  const data = http.json(body);
  if (!data || typeof data !== "object") {
    return null;
  }
  if (!("five_hour" in data) && !("seven_day" in data)) {
    return null;
  }
  const five = normalizeWindow(data.five_hour);
  const seven = normalizeWindow(data.seven_day);
  if (five === null && seven === null) {
    return null;
  }
  return { five_hour: five, seven_day: seven };
}

// get(token) -> {ok, limits} | {ok: false, why}
// why: expired | throttled | unreachable | unexpected
async function get(token) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply;
    try {
      reply = await http.request(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
          "User-Agent": env.userAgent(),
        },
        timeoutMs: TIMEOUT_MS,
      });
    } catch {
      continue; // a stalled connection is tried once more
    }
    if (reply.status === 200) {
      const limits = normalize(reply.body);
      return limits ? { ok: true, limits } : { ok: false, why: "unexpected" };
    }
    if (reply.status === 401 || reply.status === 403) {
      return { ok: false, why: "expired" };
    }
    if (reply.status === 429) {
      return { ok: false, why: "throttled" }; // also what an expired token gets
    }
  }
  return { ok: false, why: "unreachable" };
}

// token(id) -> {ok, token} | {ok: false, why}: the account's token, renewing
// a saved account's login first if it has expired.
async function token(id) {
  if (id === gconfig.activeId() && store.present()) {
    const blob = store.read();
    const live = blob && blob.claudeAiOauth && blob.claudeAiOauth.accessToken;
    return live ? { ok: true, token: live } : { ok: false, why: "expired" };
  }
  let record = vault.get(id);
  if (!record) {
    return { ok: false, why: "expired" };
  }
  if (oauth.expired(record)) {
    let why = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Renewals go one at a time within the process: a Promise.all over accounts
      // would otherwise slip past the file lock, which only keeps processes apart.
      why = await util.serialize(() => oauth.renewVault(id));
      if (why === null || why !== "unreachable") {
        break;
      }
    }
    if (why !== null) {
      const kind = why === "invalid_grant" || why === "disabled" || why === "active" ? "expired" : why;
      return { ok: false, why: kind };
    }
    record = vault.get(id);
    if (!record) {
      return { ok: false, why: "expired" };
    }
  }
  const access = record.claudeAiOauth && record.claudeAiOauth.accessToken;
  return access ? { ok: true, token: access } : { ok: false, why: "expired" };
}

const PROBLEM_TEXT = {
  expired: "login expired — /login to it again, then click ＋ save",
  throttled: "Anthropic is throttling this login's requests; trying again later",
  unexpected: "the endpoint answered in a shape claude-acct does not know",
  unreachable: "could not be reached",
};

// refresh({ids, maxAgeSec}) -> {stored, problems: [one line per account]}
// Accounts are asked in parallel; never fails the caller.
async function refresh({ ids = null, maxAgeSec = 0 } = {}) {
  const list = ids && ids.length ? ids : vault.indexRead().accounts.map((a) => a.id);
  if (!list.length) {
    return { stored: false, problems: [] };
  }
  const now = util.nowSec();
  const rl = ratelimits.read();
  const wanted = list.filter((id) => {
    if (maxAgeSec <= 0) {
      return true;
    }
    const fetched = (rl.accounts[id] && rl.accounts[id].fetchedAt) || 0;
    return now - fetched >= maxAgeSec;
  });
  if (!wanted.length) {
    return { stored: false, problems: [] };
  }

  const results = await Promise.all(
    wanted.map(async (id) => {
      // Each account on its own: a busy vault file or a failed renewal
      // must not break the round for the others.
      try {
        const t = await token(id);
        if (!t.ok) {
          return { id, ok: false, why: t.why };
        }
        const answer = await get(t.token);
        return answer.ok ? { id, ok: true, limits: answer.limits } : { id, ok: false, why: answer.why };
      } catch (e) {
        util.log(`usage ${id}: ${e.message}`);
        return { id, ok: false, why: "unexpected" };
      }
    })
  );

  let stored = false;
  const problems = [];
  for (const result of results) {
    if (result.ok) {
      const ok = ratelimits.update((state) => {
        state.accounts[result.id] = {
          ...(state.accounts[result.id] || {}),
          ...result.limits,
          fetchedAt: util.nowSec(),
          source: "api",
        };
        return state;
      });
      stored = stored || ok;
    } else {
      problems.push(`${vault.indexLabel(result.id)}: ${PROBLEM_TEXT[result.why] || PROBLEM_TEXT.unreachable}`);
    }
  }
  return { stored, problems };
}

module.exports = { USAGE_URL, FRESH_SECONDS, AUTO_SECONDS, normalize, get, token, refresh };
