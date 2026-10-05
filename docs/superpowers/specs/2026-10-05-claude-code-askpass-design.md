# cc-askpass — Design

Status: approved design, not yet implemented (2026-10-05).
Supersedes `DESIGN.md` where they disagree (notably: no password cache, English code comments).

## 1. Problem

Claude Code's Bash tool runs commands without a TTY (stdin is `/dev/null`). When a command
needs a sudo password it fails with `sudo: a terminal is required to read the password`.

Goal: a Claude Code mod (function-hooks plugin) that, when a command run by Claude needs a
sudo password (directly, or indirectly from a script or installer), shows a password pane
inside Claude Code. The password must never enter the model's context.

The project is open source: code comments, logs and error messages are in English; the
README ships in English (default), Traditional Chinese and Simplified Chinese.

### Success criteria

- Claude runs `sudo apt update`; a pane asks for the password; the command succeeds.
- A wrong password re-asks with a "Sorry, try again" hint.
- An ssh key passphrase and a git HTTPS username/password are asked the same way.
- Works with zero manual configuration after installing the plugin.
- A request forged by a command running as the user is rejected, not shown.

## 2. Scope

| In scope | Out of scope |
|---|---|
| sudo password, including sudo called from scripts/installers | `su`, `doas` (no askpass support): use sudo |
| ssh key passphrases, git HTTPS credentials via `SSH_ASKPASS` | polkit (`pkexec`, `run0`, `systemctl` as non-root): fails fast with "Interactive authentication required" |
| Linux and WSL (tested) | Native Windows Claude Code |
| macOS (portable POSIX code, untested in v1) | y/n prompts: use `-y`, `--no-interaction`, etc. |
| | ssh `SSH_ASKPASS_PROMPT=confirm/none` (agent key confirm, FIDO touch): treated as a plain text prompt; `none` closes when ssh kills the helper |
| | Password caching (see 5.4) |

Rejected approach: wrapping every command in a PTY (pagers, color codes, merged
stdout/stderr, lost `cd`, guessing when input is needed).

## 3. Verified facts

- sudo 1.9.15p5 (WSL Ubuntu): with `SUDO_ASKPASS` **and** `DISPLAY` set and no controlling
  TTY, sudo calls the askpass program automatically (no `-A`), also when sudo runs inside a
  child script. `SUDO_ASKPASS` alone fails. Probe:
  `DISPLAY=:0 SUDO_ASKPASS=/tmp/ap.sh setsid sudo -k true </dev/null`.
- askpass receives the prompt as `$1`, e.g. `[sudo] password for alice: `.
- sudo passes the caller's environment to the askpass program unchanged.
- Without a TTY, sudo's default timestamp is tied to the parent process, so each Bash
  command asks again.
- Mods API (Claude Code 2.1.289):
  - `$.env.set(name, value)` changes the Claude Code process environment; every Bash child
    started afterwards inherits it. Names must be string literals.
  - `$.process.spawn({ argv })` streams output via `for await`; the child is killed when the
    loop ends or the module unloads (hot reload included).
  - `$.process.run(argv, { stdin, timeoutMs })` runs a command once; stdin is one string.
  - `$.plugin.root()`, `$.session.id()` exist.
  - `$.ui.open({ id, title, focus, closeOnEscape })` opens a pane drawn by a `ui.render`
    hook on `{ component: 'Pane', requestId: id }`. A pane opened "unasked" (from a timer,
    `session.start`, or any non-user event) is only placed from 144 terminal columns
    (110 for an id the user opened before); below that it waits undrawn and `ui.open`
    resolves `{ isPlaced: false }`.
  - `$.command.register({ name, description, immediate: true })`: an immediate command runs
    even while a turn is in flight.
  - `Input` has no password-mask prop.
  - Module variables reset on hot reload; `$.state` / `$.store` persist. Secrets live only in
    module/local variables.

## 4. Architecture

```
Claude Bash → sudo (no TTY; DISPLAY + SUDO_ASKPASS set by the mod)
                └─ bin/askpass "<prompt>"
                     ├─ mkfifo <dir>/reply.<own pid>
                     ├─ write one line to <dir>/req
                     └─ read one line from reply FIFO → stdout → sudo

mod
  ├─ session.start: spawn `bin/askpass --serve <session id>`, wait for `ready\t<dir>`,
  │                 then $.env.set(...)
  ├─ each output line = one request → verify → queue → pane
  └─ reply: $.process.run(["sh","-c",'[ -p "$1" ] || exit 1; exec 3<>"$1";
                           [ -p /dev/fd/3 ] || { rm -f "$1"; exit 1; }; cat >&3',
                           "_", replyFifo], { stdin: password + "\n" })
     (the second check catches the FIFO being removed between the test and the open,
     since `<>` would create a regular file)
```

### 4.1 Repository layout

The repo root is both the plugin and its marketplace.

```
.claude-plugin/plugin.json        name, version, description (no userConfig)
.claude-plugin/marketplace.json   lets users `claude plugin marketplace add <repo>`
hooks/hooks.json                  { "modules": ["./register.tsx"] }
hooks/register.tsx                event wiring, pane, /askpass command, process calls
hooks/core.ts                     pure logic, no `$`: request parsing, verification
                                  decision, mask diff, mask rule, retry detection
hooks/core.test.ts
hooks/pane.test.ts
bin/askpass                       POSIX sh helper (executable bit committed)
tests/askpass.sh                  shell round-trip test, run on Linux/WSL
README.md, README.zh-TW.md, README.zh-CN.md   each links to the other two at the top
LICENSE                           MIT
.gitattributes                    `* text=auto eol=lf` (bin/askpass breaks with CRLF)
```

### 4.2 `bin/askpass`

POSIX sh, no bashisms. Two modes.

**`askpass --serve <session id>`** (started by the mod):

1. `umask 077`. Base dir: `$XDG_RUNTIME_DIR/cc-askpass` if `XDG_RUNTIME_DIR` is
   set, else `/tmp/cc-askpass-$(id -u)`. Create it with `mkdir` (mode 0700); if it
   already exists, require that it is a directory, not a symlink, owned by the current user
   (`[ -d ] && [ ! -L ] && [ -O ]`), else exit 1 with a message on stderr.
2. Session id must not be empty, `.`, `..` or contain `/`. Session dir:
   `<base>/<session id>-<pid of the Claude Code process>` (two processes resuming one session
   keep separate dirs). Remove it if present, recreate (0700), `mkfifo req`, write the serve
   shell's pid to `serve.pid`.
3. Print `ready\t<session dir>`.
4. `exec 3<>req`, then `while IFS= read -r line <&3; do printf '%s\n' "$line"; done`.
   Only shell builtins run in the loop, so killing the shell leaves no child behind, and
   opening `req` read-write means the loop never sees EOF.

**`askpass <prompt>`** (called by sudo/ssh/git):

1. If `CC_ASKPASS_DIR` is unset or not a directory, or the pid in `serve.pid` is not alive
   (the mod was disabled mid-session): message on stderr, exit 1.
2. `umask 077`; remove a stale `reply.$$` (left by a SIGKILLed helper with this pid), then
   `mkfifo "$CC_ASKPASS_DIR/reply.$$"`; exit 1 if that fails.
3. Start a watchdog with stdin/stdout/stderr on /dev/null (ssh and git read askpass output
   until EOF): it checks every 5 s that the helper is alive, exits when it is not, and kills
   the helper after 10 minutes. `trap` on EXIT/INT/TERM/HUP removes the reply FIFO and kills
   the watchdog.
4. Write one line to `req`: `<own pid>\t<prompt with tabs and newlines replaced by spaces,
   cut to 1000 characters>` (well under PIPE_BUF, so concurrent writes never interleave).
5. Read one line from the reply FIFO. Empty → exit 1 (sudo prints "no password was
   provided"). Otherwise print it to stdout, exit 0.

### 4.3 Mod lifecycle

- **`session.start`**: when `e.isInteractive` is false (`-p`, the SDK) do nothing: nobody could
  answer, so sudo should fail at once as without the mod. Otherwise spawn `[<root>/bin/askpass, --serve, <session id>]`. If the first line
  is not `ready\t<dir>` within 5 s: toast the error, set nothing. Otherwise:
  - `$.env.set("CC_ASKPASS_DIR", dir)`
  - `$.env.set("SUDO_ASKPASS", askpassPath)`, `$.env.set("SSH_ASKPASS", askpassPath)`
  - `$.env.set("SSH_ASKPASS_REQUIRE", "force")`
  - `DISPLAY`: only if unset, set to `:0` and set `CC_ASKPASS_SET_DISPLAY=1`. A `:0` with that
    marker is ours (the marker survives a hot reload); a `:0` without it (WSLg) is left alone.
  - Register `/askpass` (`immediate: true`).
  - Every later output line is passed to request handling (section 5).
- **Serve exits unexpectedly** (not a module unload): unset the variables above (`DISPLAY`
  only if we set it), toast "askpass listener stopped". No automatic restart.
- **Hot reload**: the old serve is killed with the module; the new module's `session.start`
  recreates the session dir and re-sets the same variables.
- **`session.end`**: remove the session dir when the process ends (`prompt_input_exit`, `logout`,
  `other`). After `/clear` or an in-process resume the process goes on under a new session id
  and no `session.start` fires, so the listener, its dir and the env stay as they are.

## 5. Request handling

### 5.1 Verification

The mod never trusts what the request line says about its origin. For each line
`<helper pid>\t<prompt>`:

1. `ps -o ppid=,args= -p <helper pid>`. If the process is gone, drop the request. If `args`
   does not contain `<root>/bin/askpass`, the request is forged: do not show a pane, do not
   reply, toast "Rejected forged askpass request (pid N)", log to debug.
2. `ps -o user=,comm=,args= -p <ppid>`:
   - `user` is `root` and the basename of `comm` is `sudo` → **sudo request** (macOS `ps`
     prints the full path in `comm`).
   - anything else → **other request**, labelled with the parent's `comm` and pid, accepted only
     when `comm` is `ssh`, `ssh-add`, `scp`, `sftp` or `git-remote-http` (not plain `git`:
     `git credential fill` prints the answer to stdout) and the parent's
     `/proc/<pid>/exe` resolves to a root-owned file named like `comm`. Otherwise it is
     rejected with a toast and an empty reply: a shell running `$SUDO_ASKPASS` itself would
     read the answer from the helper's stdout. macOS has no `/proc`, so ssh/git are rejected there.
   - The helper path must be the program or its interpreter's first argument (`^(\S+ )?<path>`),
     so a path smuggled into a sudo `-p` prompt does not pass.

### 5.2 Queue

Requests are queued in arrival order; the pane serves one at a time. When a request ends
(submitted, cancelled, or its helper is gone) the next one is shown.

### 5.3 Pane

- Title: sudo request → "sudo password"; other → "Password requested by `<comm>` (pid N)".
- Shows a heading ("sudo needs your password" / "<comm> (pid N) needs a password"), the
  parent's whole command line as `$ <args>` (`ps -ww`, wrapped, capped at 2000 chars), the
  prompt on its own line (trailing colon dropped), then the Input with the Show/Hide Button
  beside it, and Cancel on the line below.
- "Claude ran: <command>": the mod records Claude's last 50 Bash commands (`tool.call`), walks
  `ps -e` up from the requester to the shell whose parent is Claude Code (pid from the session
  dir name), and shows the recorded command found in that shell's args (quotes `'"'"'` undone,
  longest match). Shown only when it differs from the `$` line; first 5 lines of a script.
- Retry hint: the mod remembers which sudo pids it has answered (`Map<pid, time>`, entries
  older than 10 minutes pruned). A new request from an already-answered sudo pid means the
  previous password was wrong: show "Sorry, try again".
- Open with `$.ui.open({ id: "askpass", title, focus: true, closeOnEscape: true })`.
- `focus: true` is a request: with text in the composer, a dialog, or another site holding the
  keys, the pane opens without the keyboard. While `isFocused` is false the pane's first line
  says, in red, "Click this pane (or press ctrl+x tab) before typing — your keys are going to
  the prompt below.", so a password is not typed into the composer and sent to Claude. The mod
  does not re-grab focus later: it could land mid-way through a message being typed.
- Placement is the surface's: docked beside a fullscreen transcript from 110 columns, else
  inline above the prompt. `ui.open` takes no placement option.
- **Not placed** (`isPlaced: false`, narrow terminal): the `AbovePrompt` band shows
  "`<comm>` is waiting for a password — click the button below or type /askpass" on one line
  and an `Open password prompt` Button (`autoFocus`, so ctrl+x tab then Enter presses it) below.
  The Button (key `open-askpass`) and `/askpass` are user-asked opens, placed at any width.
  The band clears when the pane opens or the request ends, and yields to a survey.
  On the terminal's main screen (`viewport.isFullscreen === false`) clicks are not reported, so
  the band says "press ctrl+x tab then Enter, or type /askpass" and the focus warning says
  "Press ctrl+x tab before typing"; elsewhere they mention clicking.
  Verified: a mouse click presses the Button mid-turn; a bare digit hotkey does not (it is
  typed into the composer), and the band cannot take the keyboard by itself
  (`$.ui.focus` → "that site does not hold the keyboard"). `/askpass` with nothing pending
  toasts "No pending password request".
- Submit → reply with the password, record the sudo pid, close/advance.
- Esc, the close mark, or the Cancel button → reply an empty line (the helper exits 1), advance.
- The Input key is `password-<helper pid>-<load id>` (the load id is random per module load):
  an Input keeps its previous text under a reused key, ignoring `value`, and after a reload
  the same request comes back while the new module knows none of that text.
- Making a request current invalidates `ui.render`: a pane still open from before a reload is
  not drawn again by `ui.open`.
- On the mobile surface (no Input) the pane says "Answer this prompt in the terminal or the
  desktop app."
- While the pane is open, check `sh -c 'kill -0 \"$1\"'` (the builtin; `/bin/kill` may be absent) every 2 s (`$.clock.every`); if the
  helper is gone (Bash timeout, sudo killed), close the pane and advance.

### 5.4 No password cache

The mod does not cache passwords. A cached password could be read by any same-uid process
racing the reply FIFO, and it is often the user's login password. Users who want "ask once
per N minutes" add `Defaults:<user> timestamp_type=global` to sudoers (documented in the
README): sudo then caches the authentication, not the password.

### 5.5 Masking

- Sudo requests: always masked.
- Other requests: masked unless the prompt matches a known non-secret pattern:
  - `^Username for '` (git HTTPS username; git does not translate this string)
  - `\(yes/no` (ssh host-key confirmation; ssh is not localized)
- A Show/Hide button toggles masking manually.
- Mechanism: the `Input` is controlled with `value = '•'.repeat(real.length)`. In `onInput`,
  if the new value is longer, append the extra characters to the real value; if shorter,
  truncate the real value to the new length. Known limitation: editing in the middle of the
  field (cursor moved) is not tracked.
- Fallback if the mechanism fails the spike: no masking; the field is cleared on submit;
  the README states this.
- The real value lives in a module variable for the open pane only and is cleared on
  submit, cancel and close.

## 6. Error handling

| Situation | Behavior |
|---|---|
| Serve fails to start or no `ready` in 5 s | Toast error; env not set; sudo behaves as without the mod |
| Serve exits unexpectedly | Unset env vars (DISPLAY only if ours); toast; no restart |
| Helper: `CC_ASKPASS_DIR` missing or `mkfifo` fails | Message on stderr, exit 1 |
| Helper waits too long | Watchdog ends it after 10 min |
| Reply FIFO missing when replying | `[ -p ]` guard exits 1; nothing is written to a regular file |
| Reply write fails or exceeds 5 s | Debug log; advance the queue |
| Malformed request line | Ignore; debug log |
| `ps` missing or failing while checking a request | Toast "could not check an askpass request", reply empty |
| Forged request (helper is not our askpass) | Not shown, not answered; toast + debug log |

## 7. Security boundaries

- The password exists only in the mask's real-value variable and in the `stdin` string of
  one `$.process.run` call. Never in `$.state`, `$.store`, logs, toasts, status, or argv.
- Runtime dirs are 0700 and FIFOs 0600 (umask 077); the `/tmp` base is checked for
  ownership and symlinks.
- Forged requests and phishing panes are blocked by verification (5.1); the pane shows the
  real requesting command so the user can judge.
- Documented limitation: a malicious process running as the same user can race to read the
  reply FIFO of a genuine request. The tool keeps the password out of the model's context in
  normal operation; it is not a sandbox against hostile code running as the user.
- Side effect of a fake `DISPLAY` (only on hosts without one): a few GUI programs (e.g.
  `xdg-open`) may try to connect to X and fail. Documented in the README.

## 8. Testing

- `hooks/core.test.ts` (`claude plugin test`): request parsing; verification decision from
  canned `ps` output (forged, sudo, other, vanished); mask diff (append, delete, paste);
  mask rule (sudo, localized sudo prompt, `Username for '`, `(yes/no`, unknown prompt);
  retry detection and pruning.
- `hooks/pane.test.ts`: mount the pane on `terminal` and `desktop`; type, submit, cancel;
  assert the reply via a mocked `$.process.run`; assert the password never appears in
  toasts, status or logs.
- `tests/askpass.sh` (Linux/WSL): serve + helper round trip with a fake parent; empty reply
  → exit 1; missing `CC_ASKPASS_DIR` → exit 1; reply guard does not create a regular file;
  `/tmp` base owned by someone else or a symlink → serve refuses.
- Manual end-to-end checklist (WSL, `claude --plugin-dir .`): `sudo apt update`; wrong
  password then right one; Esc; Bash timeout closes the pane; narrow terminal → status line
  + `/askpass`; ssh key passphrase; git HTTPS username (unmasked) and password (masked);
  forged request line written to `req` → rejected.

## 9. Spikes before building

Run these first; a failure sends the design back for revision.

1. Controlled `value` masking works (re-render keeps the field, fast typing, backspace, paste).
2. A pane opened from an `immediate` command's `command.run` is placed at any width.
3. With `timestamp_type=global`, a successful askpass authentication suppresses the next
   prompt from a separate Bash command.
4. The `ps -o args=` format of the helper when exec'd by sudo (does it contain the script
   path as expected).

## 10. Documentation and release

- README in three languages with: what it does, install
  (`claude plugin marketplace add <repo>` + install), how it works, the optional sudoers
  `timestamp_type=global` line, limitations (section 2 out-of-scope, masking limitation,
  same-uid limitation, fake `DISPLAY` side effect), uninstall.
- Code comments, log lines and error messages in English.
- License: MIT.
