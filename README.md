# claude-acct-win

Switch [Claude Code](https://code.claude.com) between **your own** accounts with one click in the
status line — on Windows, no browser, no re-login.

```
D:\repos\aqua · ctx 32% · 5h 24% ⟳14:20 · 7d 5%
● me@example.com 5h 24%↻2h · 7d 5%↻5d  │  work@example.com 5h 80%↻1h   ⤡ collapse  ↻ limits
```

The first line is your own status line, left as it was. The second holds the accounts and the
controls: the active one is orange, and each account, limits included, is one
link. Everything except the login stays the same: `CLAUDE.md`, settings, plugins, MCP servers,
projects, history. Switching does to your credentials exactly what `/login` does, without
the browser round trip.

This is a port of [kotigor/claude-acct](https://github.com/kotigor/claude-acct) (macOS and Linux,
bash + jq + curl) to Node: on Windows it needs no jq, no curl and no Git Bash, and drawing
the account row takes ~80 ms instead of ~1 s spent emulating fork in MSYS.

## Is this allowed?

claude-acct is for people who pay for more than one Claude subscription themselves. Anthropic's terms
forbid sharing accounts, reselling access, and automated access beyond what they
permit. claude-acct only switches between your own logins, and
only when you click. It never sends a prompt on its own, never "warms up" accounts
and never proxies traffic; the only requests it makes by itself are read-only limits lookups, the same
ones Claude Code makes, at most every five minutes, and the standard OAuth renewal of a
saved login whose access token has expired. Read the
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and the
[Usage Policy](https://www.anthropic.com/legal/aup) and decide for yourself.

## Requirements

- Windows, and Claude Code with fullscreen rendering (`/tui fullscreen`): clicks in the status line
  only work there.
- Node 20+ (usually already installed alongside Claude Code).
- For clicks, `csc.exe` from the .NET Framework (every Windows has it, in
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319`). The installer builds a tiny
  link handler with it; nothing to download.
- A terminal in which the click reaches Claude Code. **Windows Terminal: Alt+click.** Ctrl+click
  switches too, but Windows Terminal also opens the link itself as an empty browser tab
  (checked with a probe: a Ctrl+click reached both the link handler and Chrome; an Alt+click, only the
  link handler). A plain click does nothing. The VS Code terminal opens links by itself, so the click
  never gets there; switch with `claude-acct use` instead.

## Install

```powershell
git clone https://github.com/AFomishkin/claude-acct-win.git D:\repos\claude-acct-win
cd D:\repos\claude-acct-win
node install.js            # --dry-run shows what would be done without changing anything
```

The installer puts a working copy in `%LOCALAPPDATA%\claude-acct\app`, builds
`claude-acct-opener.exe`, adds its own `statusLine` and `env.BROWSER` to `~/.claude/settings.json`,
and remembers the previous status line and keeps drawing it as the first line.
The `claude-acct` command goes into `~/.local/bin`.

The account row shows up in sessions that are already open too: Claude Code re-reads `statusLine` on
the fly. But **clicks only work in sessions started after installing**: `env.BROWSER`
is handed to a session at startup and cannot be changed while it runs. In older windows,
`claude-acct use` works in the meantime.

## Add your accounts

For each account:

1. `/login` in Claude Code.
2. Click **＋ save** in the status line (or run `claude-acct save`).

> **Never use `/logout` to switch.** It revokes the login on Anthropic's side, and the
> saved copy stops working. `/login` does not revoke anything.

## Switch

Alt+click an account in the status line (Ctrl+click switches too, but Windows Terminal also
opens an empty browser tab). The row updates within a couple of seconds and open sessions
follow. From a terminal:

```powershell
claude-acct list
claude-acct refresh                # update the limits of every account
claude-acct use work@example.com   # id, label or email
claude-acct restore                # undo the last switch
claude-acct rename work@example.com work
claude-acct rm work
claude-acct doctor
```

## How it works

- **Credentials.** On Windows Claude Code keeps its login in `~/.claude/.credentials.json`
  (there is no macOS Keychain here). The same record holds MCP logins and plugin secrets, so
  claude-acct changes only the keys that belong to the account (`claudeAiOauth`, `designOauth`,
  `trustedDeviceToken`, `organizationUuid`) and `oauthAccount` in `~/.claude.json`, verifies
  the write by reading it back, and rolls back on failure.
- **Saved accounts** live in `%LOCALAPPDATA%\claude-acct\vault` (the installer turns off permission
  inheritance on the folder and leaves access to your Windows user only). Claude Code rotates
  refresh tokens while an account is in use, and `/login` to another account drops the old ones,
  so claude-acct re-saves the active account's tokens before every switch and,
  every few minutes, whenever they changed.
- **Clicks.** The status line prints `http://claude-acct.localhost/…` links as OSC 8. Claude
  Code opens a clicked link with `$BROWSER`, which points to `claude-acct-opener.exe`: it hands our
  links to `claude-acct open-url` and every other link to wherever it went before.
  A scheme of our own (`claude-acct://`) is not an option: on click Claude Code only lets through
  links from its allowlist of schemes (`http`, `https`, `vscode`, `cursor`, `zed`, …).
- **Redraws.** Claude Code re-runs the status line command the moment it changes in
  `settings.json`, so after a click and after a background limits refresh claude-acct
  puts a fresh `--tick <ms>` argument on its own command; the value only grows, so
  changes that land close together merge into one redraw. The timer (`refreshInterval: 60` unless
  your own status line set one) moves the countdown and keeps the limits fresh in an idle session.
- **Limits.** Claude Code reports limits only for the active account. For the rest,
  claude-acct asks the same endpoint Claude Code itself uses
  (`GET /api/oauth/usage`) with each account's own token, so the row shows real numbers for
  everyone. At most once every 5 minutes (the same interval Claude Code caches them for), plus on
  a switch and via the `↻ limits` link. No prompt is sent and no quota is consumed. Numbers
  older than an hour show as `?`. Right after a switch the session keeps reporting the numbers of
  the account you left for a while; claude-acct recognises those leftovers and never files them
  under the new account.
- **Error messages** appear as a third line of the status line, with a `✕ hide` link:
  there are no pop-up notifications in the terminal.

## Limitations

- The limits endpoint is undocumented and could change; the row then shows the last
  known numbers.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`,
  cloud providers and gateways take precedence over `/login`; while they are set, switching has no
  effect (`claude-acct doctor` tells you so).
- A project `.claude/settings.json` with its own `statusLine` hides the switcher in that project.
- If a session refreshes its token at the very moment you switch, the saved copy of that account
  can go stale: `/login` to it and click **＋ save** again.

## Uninstall

```powershell
claude-acct uninstall           # keeps saved accounts
claude-acct uninstall --purge   # also deletes them
```

The settings you had before installing are restored.

## Development

```powershell
node --test "tests/*.test.js"
```

Tests run in a temporary profile; they never touch your real credentials.

## License

MIT, same as the original project.
