"use strict";
// Source hygiene: no raw control or invisible characters in tracked files.
// Such characters sneak in when an editor or a tool turns an escape like
// backslash-u-0000 into the character itself: the code still works, but git
// starts treating the file as binary and diffs stop showing what changed.
// The characters are checked by code point, so this file itself contains none.

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function isInvisible(code) {
  if (code === 9 || code === 10 || code === 13) {
    return false;
  }
  if (code < 32 || code === 127) {
    return true;
  }
  if (code === 0xa0 || code === 0xfeff || code === 0x2028 || code === 0x2029) {
    return true;
  }
  return code >= 0x200b && code <= 0x200f;
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    // not a git checkout (an unpacked archive): check the sources we ship
    return ["install.js", "opener/Opener.cs", "README.md"]
      .concat(fs.readdirSync(path.join(ROOT, "src")).map((f) => `src/${f}`))
      .concat(fs.readdirSync(path.join(ROOT, "tests")).map((f) => `tests/${f}`));
  }
}

test("tracked files contain no raw control or invisible characters", () => {
  const found = [];
  for (const rel of trackedFiles()) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      continue;
    }
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const ch of line) {
        const code = ch.codePointAt(0);
        if (isInvisible(code)) {
          found.push(`${rel}:${index + 1} U+${code.toString(16).padStart(4, "0")}`);
        }
      }
    });
  }
  assert.deepEqual(found, [], `write these as escapes instead: ${found.join(", ")}`);
});
