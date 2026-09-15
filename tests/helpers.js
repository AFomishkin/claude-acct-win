"use strict";
// Shared test scaffolding: every test gets its own profile in a temp directory,
// the user's real files are never touched.

const fs = require("fs");
const os = require("os");
const path = require("path");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acct-test-"));
  const home = path.join(root, "home");
  const config = path.join(home, ".claude");
  fs.mkdirSync(config, { recursive: true });
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.CLAUDE_ACCT_DATA_DIR = path.join(root, "data");
  process.env.LOCALAPPDATA = path.join(root, "local");
  process.env.CA_USAGE_SYNC = "1"; // no background processes in tests
  process.env.CA_NO_BACKGROUND = "1"; // and no detached ones either
  process.env.CLAUDE_ACCT_AUTO_REFRESH = "0";
  process.env.NO_COLOR = "1";
  process.env.COLUMNS = "200";
  for (const name of [
    "BROWSER",
    "FORCE_HYPERLINK",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_PROFILE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CA_POKED_AT",
  ]) {
    delete process.env[name];
  }
  return { root, home, config };
}

function cleanup(ctx) {
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

function oauth(name, plan = "max") {
  return {
    accessToken: `at-${name}`,
    refreshToken: `rt-${name}`,
    expiresAt: 4102444800000,
    refreshTokenExpiresAt: 4102444800000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: plan,
    rateLimitTier: "default_claude_max_20x",
  };
}

function account(name, org = null) {
  return {
    accountUuid: `acc-${name}`,
    organizationUuid: org || `org-${name}`,
    emailAddress: `${name}@example.com`,
    organizationName: `Org ${name}`,
    displayName: name,
    billingType: "stripe_subscription",
  };
}

function credentialsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
}

function globalConfigPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// What /login in Claude Code leaves behind.
function login(name, { org = null, plan = "max" } = {}) {
  const current = readJson(credentialsPath(), {
    mcpOAuth: { srv: { accessToken: "mcp-secret" } },
    pluginSecrets: { p: "s" },
  });
  delete current.designOauth;
  delete current.trustedDeviceToken;
  delete current.organizationUuid;
  current.claudeAiOauth = oauth(name, plan);
  current.trustedDeviceToken = `tdt-${name}`;
  fs.writeFileSync(credentialsPath(), JSON.stringify(current, null, 2));
  const config = readJson(globalConfigPath(), { numStartups: 1 });
  config.oauthAccount = account(name, org);
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2));
}

// Claude Code rotated the active account's tokens.
function rotate(suffix) {
  const blob = readJson(credentialsPath(), {});
  blob.claudeAiOauth.accessToken = `at-${suffix}`;
  blob.claudeAiOauth.refreshToken = `rt-${suffix}`;
  fs.writeFileSync(credentialsPath(), JSON.stringify(blob, null, 2));
}

function liveRefreshToken() {
  return readJson(credentialsPath(), {}).claudeAiOauth.refreshToken;
}

function liveEmail() {
  const config = readJson(globalConfigPath(), {});
  return config.oauthAccount ? config.oauthAccount.emailAddress : null;
}

// Remove OSC 8 links and colour from the status line output, keep the text.
function strip(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function session(fivePct, fiveReset, sevenPct, sevenReset) {
  return JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: fivePct, resets_at: fiveReset },
      seven_day: { used_percentage: sevenPct, resets_at: sevenReset },
    },
  });
}

module.exports = {
  setup,
  cleanup,
  oauth,
  account,
  credentialsPath,
  globalConfigPath,
  readJson,
  login,
  rotate,
  liveRefreshToken,
  liveEmail,
  strip,
  session,
};
