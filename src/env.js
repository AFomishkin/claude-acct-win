"use strict";
// Where Claude Code keeps its files and where we keep ours.
// The lookup follows the same rules Claude Code itself uses.

const os = require("os");
const path = require("path");
const fs = require("fs");

function home() {
  return process.env.USERPROFILE || os.homedir();
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
}

// The global config: in CLAUDE_CONFIG_DIR when that is set, otherwise in the profile.
function globalConfigPath() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
  }
  return path.join(home(), ".claude.json");
}

function settingsPath() {
  return path.join(configDir(), "settings.json");
}

// The directory Claude Code keys credential storage to.
function secureStorageDir() {
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) {
    return process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || path.join(home(), ".claude");
  }
  return configDir();
}

function credentialsFile() {
  return path.join(secureStorageDir(), ".credentials.json");
}

// Our data: %LOCALAPPDATA%\claude-acct. Tests and debugging override it with CLAUDE_ACCT_DATA_DIR.
function dataDir() {
  if (process.env.CLAUDE_ACCT_DATA_DIR) {
    return process.env.CLAUDE_ACCT_DATA_DIR;
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    return path.join(local, "claude-acct");
  }
  return path.join(home(), ".local", "share", "claude-acct");
}

function appDir() {
  return process.env.CA_APP || path.join(dataDir(), "app");
}

function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return dataDir();
}

// Whether a directory is on PATH (for the hint about the claude-acct command).
function onPath(dir) {
  const normalize = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  let wanted;
  try {
    wanted = normalize(dir);
  } catch {
    return false;
  }
  return (process.env.PATH || "").split(path.delimiter).some((entry) => {
    if (!entry) {
      return false;
    }
    try {
      return normalize(entry) === wanted;
    } catch {
      return false;
    }
  });
}

function version() {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  } catch {
    return "dev";
  }
}

// Requests say who they are: Anthropic's edge answers a nameless client with 429 whatever it asks.
function userAgent() {
  return `claude-acct-win/${version()}`;
}

// Credential sources that take precedence over /login: while any is present, a switch has no effect.
const OVERRIDE_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
];

const OVERRIDE_SETTINGS_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
]);

function overrides() {
  const found = [];
  for (const name of OVERRIDE_ENV) {
    if (process.env[name]) {
      found.push(name);
    }
  }
  if (process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ANTHROPIC_ORGANIZATION_ID) {
    found.push("ANTHROPIC_FEDERATION_RULE_ID");
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return found;
  }
  if (settings && settings.apiKeyHelper) {
    found.push("apiKeyHelper");
  }
  const env = (settings && settings.env) || {};
  for (const key of Object.keys(env)) {
    if (OVERRIDE_SETTINGS_ENV.has(key)) {
      found.push(`settings.env.${key}`);
    }
  }
  return found;
}

module.exports = {
  home,
  configDir,
  globalConfigPath,
  settingsPath,
  secureStorageDir,
  credentialsFile,
  dataDir,
  appDir,
  ensureDataDir,
  onPath,
  version,
  userAgent,
  overrides,
};
