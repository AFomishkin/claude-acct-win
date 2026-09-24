"use strict";
// Which links the link handler takes for the sign-in link of /login and puts on the
// clipboard instead of opening. Opener.cs is built with a probe around it, the same way
// install.js builds the handler, so the check runs without touching the clipboard.

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cscPath, OPENER_CSC_ARGS } = require("../install");

const PROBE = `
internal static class OpenerProbe
{
    private static void Main(string[] args)
    {
        foreach (string url in args)
        {
            System.Console.WriteLine(Opener.IsSignInLink(url) ? "sign-in" : "other");
        }
    }
}
`;

// Built the way Claude Code builds it.
function authorizeUrl(base, redirectUri) {
  const url = new URL(base);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", redirectUri);
  url.searchParams.append("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.append("code_challenge", "challenge");
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", "state");
  return url.toString();
}

const LISTENER = "http://localhost:54545/callback";
const PASTE_BACK = "https://platform.claude.com/oauth/code/callback";

const CASES = [
  ["/login with a subscription", authorizeUrl("https://claude.com/cai/oauth/authorize", LISTENER), "sign-in"],
  ["/login with the Console", authorizeUrl("https://platform.claude.com/oauth/authorize", LISTENER), "sign-in"],
  ["/login in older versions", authorizeUrl("https://claude.ai/oauth/authorize", LISTENER), "sign-in"],
  ["the Console in older versions", authorizeUrl("https://console.anthropic.com/oauth/authorize", LISTENER), "sign-in"],
  ["the link /login prints", authorizeUrl("https://claude.com/cai/oauth/authorize", PASTE_BACK), "other"],
  ["an MCP server's sign-in", authorizeUrl("https://mcp.example.com/oauth/authorize", LISTENER), "other"],
  ["a look-alike host", authorizeUrl("https://claude.com.example.com/cai/oauth/authorize", LISTENER), "other"],
  ["plain http", authorizeUrl("http://claude.com/cai/oauth/authorize", LISTENER), "other"],
  [
    "a listener that is not local",
    authorizeUrl("https://claude.com/cai/oauth/authorize", "http://localhost.example.com:54545/callback"),
    "other",
  ],
  ["no redirect at all", "https://claude.com/cai/oauth/authorize?code=true", "other"],
  ["a page on claude.ai", "https://claude.ai/settings/usage", "other"],
  ["our own link", "http://claude-acct.localhost/use/acc-work", "other"],
  ["not a link", "not a link", "other"],
];

const csc = cscPath();

test("only the sign-in link /login opens goes to the clipboard", { skip: !csc && "csc.exe not found" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acct-opener-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = path.join(dir, "probe.cs");
  const exe = path.join(dir, "probe.exe");
  fs.writeFileSync(probe, PROBE);
  execFileSync(
    csc,
    [
      ...OPENER_CSC_ARGS,
      "-target:exe",
      "-main:OpenerProbe",
      `-out:${exe}`,
      path.join(__dirname, "..", "opener", "Opener.cs"),
      probe,
    ],
    { stdio: "pipe" }
  );
  const output = execFileSync(exe, CASES.map(([, url]) => url), { encoding: "utf8" });
  const got = output.split(/\r?\n/).filter(Boolean);
  assert.deepStrictEqual(
    CASES.map(([name], i) => `${name}: ${got[i]}`),
    CASES.map(([name, , expected]) => `${name}: ${expected}`)
  );
});
