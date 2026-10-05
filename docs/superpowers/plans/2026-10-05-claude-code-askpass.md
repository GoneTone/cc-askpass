# claude-code-askpass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that answers sudo/ssh/git askpass prompts from Claude's Bash commands with an in-app password pane, keeping the password out of the model's context.

**Architecture:** A POSIX sh helper (`bin/askpass`) has two modes: `--serve` (a FIFO listener the mod spawns) and the askpass mode sudo/ssh call. The mod injects `SUDO_ASKPASS`/`SSH_ASKPASS`/`DISPLAY`/`CC_ASKPASS_DIR` into the Claude process env with `$.env.set`, reads requests from the serve process, verifies them with `ps`, shows a pane, and writes the reply into the helper's private FIFO. Pure logic lives in `hooks/core.ts`; `$` wiring and UI in `hooks/register.tsx`.

**Tech Stack:** POSIX sh; Claude Code Mods API 2.1.289 (TypeScript/TSX hooks module, `claude-code/testing`); `claude plugin validate` / `claude plugin test`.

**Spec:** `docs/superpowers/specs/2026-10-05-claude-code-askpass-design.md`

## Global Constraints

- Code comments, log lines, error messages and UI copy: English.
- Plugin name: `claude-code-askpass`; version `0.1.0`; license MIT.
- All files LF (`.gitattributes`: `* text=auto eol=lf`); `bin/askpass` committed executable (`git update-index --chmod=+x bin/askpass`).
- `bin/askpass` is POSIX sh: no bashisms (check with `sh -n` and, if available, `checkbashisms`/`shellcheck -s sh`).
- The password never goes into `$.state`, `$.store`, logs, toasts, status, argv, or any file other than the reply FIFO.
- No password cache, no `userConfig`.
- Timeouts: serve `ready` 5 s; reply write 5 s (`timeoutMs: 5000`); helper-alive poll 2 s; helper watchdog 600 s; answered-pid pruning 10 min; command line truncated to 200 chars.
- Env var names (string literals): `CC_ASKPASS_DIR`, `SUDO_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE` (`force`), `DISPLAY` (`:0`, only when unset).
- Pane id `askpass`; Input key `password`; Show/Hide Button key `toggle`; slash command `/askpass` registered `immediate: true`.
- Dev/test environment: WSL Ubuntu. Run from Windows as `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && <cmd>'`.
- API reference: the types file named when the `plugin-authoring` skill loads (`types/claude-code.d.ts`); grep it for the exact shape of any `$` call or event used below.

## Review Focus

1. A password with leading/trailing spaces, backslashes, `$`, quotes or non-ASCII must reach sudo byte-exact → Task 2 (`round trip keeps special characters`) and Task 5 (`reply stdin is password plus newline`).
2. A request line split across two spawn chunks, or two requests in one chunk → Task 3 (`splitLines` tests).
3. A queued helper that dies before its turn must not get a pane → Task 5 (`skips a queued request whose helper is gone`).
4. A prompt containing tabs, backslashes or a trailing newline must not corrupt the request line → Task 2 (`prompt with tab and backslash`).
5. Hot reload / second `session.start` for the same session id must succeed and re-set env → Task 2 (`serve twice with the same session id`) and Task 4 (`session.start twice re-sets env`).

---

### Task 1: Spikes (throwaway, gate for the rest)

Answers spec §9. Nothing here is kept. **If any spike fails, stop and report to the human before Task 2.**

**Files:**
- Create (throwaway, outside the repo): `/tmp/ap-spike.sh`, a spike mod under the `plugin-authoring` dev-mods folder.

- [ ] **Step 1: Spike 4 — `ps` format under sudo (automated)**

In WSL write `/tmp/ap-spike.sh`:
```sh
#!/bin/sh
{ ps -o ppid=,args= -p $$; ps -o user=,comm=,args= -p $PPID; } > /tmp/ap-spike.out
exit 1
```
Run: `chmod +x /tmp/ap-spike.sh; DISPLAY=:0 SUDO_ASKPASS=/tmp/ap-spike.sh setsid sudo -k apt --version </dev/null; cat /tmp/ap-spike.out`
Expected: line 1 contains `/tmp/ap-spike.sh`; line 2 starts with `root` and `sudo`, and its args contain `apt --version`. Record the exact output in the report.

- [ ] **Step 2: Spikes 1 and 2 — masking and pane placement (needs the human)**

Load `plugin-authoring`, write a spike mod in its dev-mods folder that: registers `/askpass-spike` with `immediate: true`; opens pane `spike` from the command; draws an `Input` (key `pw`) with `value = '•'.repeat(real.length)` and `onInput` applying the append/truncate rule (spec §5.5) followed by `$.ui.invalidate("ui.render")`; on submit toasts `real.length` and `real === 'test pass'`. Also open the pane once from a `$.clock.after(3000)` callback (unasked).
Ask the human to: accept hot reload; in a terminal **narrower than 110 columns**, run a long Bash command (e.g. ask Claude to `sleep 30`) and type `/askpass-spike` mid-turn; type `test pass` quickly, use backspace, paste; submit.
Expected: the pane appears mid-turn at narrow width; the field shows only `•`; the toast reports `9` and `true`. Record whether the unasked open was placed.

- [ ] **Step 3: Spike 3 — `timestamp_type=global` (needs the human)**

Ask the human to run in a WSL terminal: `echo "Defaults:$USER timestamp_type=global" | sudo tee /etc/sudoers.d/zz-askpass-spike && sudo chmod 440 /etc/sudoers.d/zz-askpass-spike`; create `/tmp/ap-pw.sh` that appends a line to `/tmp/ap-pw.log` and prints their password from a 0600 file; then run twice, in two separate `bash -c` invocations: `DISPLAY=:0 SUDO_ASKPASS=/tmp/ap-pw.sh setsid sudo true </dev/null`.
Expected: both succeed and `/tmp/ap-pw.log` has exactly one line. Afterwards remove the sudoers file, the password file and the scripts.

- [ ] **Step 4: Report**

Report each spike pass/fail with evidence. On a fail of spike 1 apply the spec's masking fallback (no masking, clear on submit) in Task 5 and the README; on a fail of 2, 3 or 4, stop for a design revision.

---

### Task 2: Helper script and its shell tests

**Files:**
- Create: `.gitattributes`, `bin/askpass`, `tests/askpass.sh`

**Interfaces:**
- Produces:
  - `bin/askpass --serve <session id>`: prints `ready\t<session dir>` then one request line per request; exits non-zero with a stderr message on an unsafe base dir.
  - `bin/askpass <prompt>`: writes `<own pid>\t<sanitized prompt>` to `$CC_ASKPASS_DIR/req`, reads one line from `$CC_ASKPASS_DIR/reply.<own pid>`, prints it, exit 0; empty reply → exit 1.
  - Session dir: `${XDG_RUNTIME_DIR}/claude-code-askpass/<id>` or `/tmp/claude-code-askpass-<uid>/<id>`.

- [ ] **Step 1: Write `.gitattributes`** with `* text=auto eol=lf`.

- [ ] **Step 2: Write the failing shell tests in `tests/askpass.sh`**

POSIX sh, a tiny `fail()` helper, each case in a function, `set -u`, temp `XDG_RUNTIME_DIR` per case (`mktemp -d`), serve run in background with stdout to a file, polling the file for lines (≤5 s). Cases:
- `serve prints ready`: first line is `ready\t$XDG_RUNTIME_DIR/claude-code-askpass/s1`; dir mode `drwx------`; `req` is a FIFO.
- `round trip keeps special characters`: start helper with `CC_ASKPASS_DIR=<dir> bin/askpass 'Password: ' > out &`; read its request from serve output, parse pid; write `'  p@ss \w$rd "é" '` + newline into `<dir>/reply.<pid>`; helper exits 0 and `out` equals the password byte-exact.
- `empty reply exits 1`: reply with an empty line → helper exit status 1, `reply.<pid>` removed.
- `prompt with tab and backslash`: prompt `$(printf 'a\tb\\c\n')` → request line is `<pid>\ta b\c ` (tab and newline become spaces, backslash kept).
- `missing CC_ASKPASS_DIR exits 1`: unset → exit 1, stderr non-empty.
- `reply guard does not create a file`: `printf 'pw\n' | sh -c '[ -p "$1" ] || exit 1; exec 3<>"$1"; cat >&3' _ <dir>/reply.999` → exit 1 and `<dir>/reply.999` does not exist.
- `unsafe tmp base is refused`: with `XDG_RUNTIME_DIR` unset, and only if `/tmp/claude-code-askpass-$(id -u)` does not exist (otherwise print `SKIP` and continue), create it as a symlink to a temp dir, assert serve exits non-zero with stderr non-empty, then remove the symlink. No test-only env override in `bin/askpass`.
- `serve twice with the same session id`: start serve `s1`, kill it, start again with `s1` → second prints `ready` and `req` is a fresh FIFO.

- [ ] **Step 3: Run to verify they fail**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && sh tests/askpass.sh'`
Expected: FAIL (`bin/askpass` missing).

- [ ] **Step 4: Implement `bin/askpass`** per spec §4.2. The two non-obvious parts:

```sh
# serve loop: builtins only, so killing this shell leaves no child behind
exec 3<>"$dir/req"
while IFS= read -r line <&3; do printf '%s\n' "$line"; done

# helper: watchdog and cleanup
( sleep 600; kill "$$" 2>/dev/null ) & watchdog=$!
trap 'rm -f "$reply"; kill "$watchdog" 2>/dev/null' EXIT
trap 'exit 1' INT TERM HUP
```
Sanitize the prompt with `printf '%s' "$1" | tr '\t\n' '  '`. Read the reply with `IFS= read -r pw < "$reply"`. Print with `printf '%s\n' "$pw"`.

- [ ] **Step 5: Run tests and lint**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && sh -n bin/askpass && sh tests/askpass.sh && (command -v shellcheck >/dev/null && shellcheck -s sh bin/askpass tests/askpass.sh || true)'`
Expected: all cases pass; no shellcheck errors.

- [ ] **Step 6: Commit**

```bash
git add .gitattributes bin/askpass tests/askpass.sh
git update-index --chmod=+x bin/askpass
git commit -m "feat: add askpass helper with serve mode"
```

---

### Task 3: Pure logic (`hooks/core.ts`)

**Files:**
- Create: `hooks/core.ts`, `hooks/core.test.ts`

**Interfaces:**
- Produces (all exported from `hooks/core.ts`):
  - `splitLines(rest: string, chunk: string): { lines: string[]; rest: string }`
  - `parseReady(line: string): string | null` — the dir from `ready\t<dir>`
  - `parseRequest(line: string): { helperPid: number; prompt: string } | null`
  - `parseHelperPs(out: string): { ppid: number; args: string } | null`
  - `isOurHelper(args: string, askpassPath: string): boolean`
  - `type Requester = { pid: number; isSudo: boolean; comm: string; command: string }`
  - `parseParentPs(out: string, pid: number): Requester | null` — `user comm args...`; `isSudo` when user is `root` and basename of `comm` is `sudo`; `command` truncated to 200 chars (append `…` when cut)
  - `shouldMask(isSudo: boolean, prompt: string): boolean`
  - `applyMaskedInput(real: string, shown: string): string`
  - `class AnsweredPids { mark(pid: number, now: number): void; has(pid: number, now: number): boolean }` — entries older than 600 000 ms are pruned

- [ ] **Step 1: Write failing tests in `hooks/core.test.ts`** (`import { test, expect } from 'claude-code/testing'`)

- `splitLines joins a line split across chunks`: `splitLines('', '12\tPass')` → `{ lines: [], rest: '12\tPass' }`; then `splitLines('12\tPass', 'word: \n13\tx\n')` → `{ lines: ['12\tPassword: ', '13\tx'], rest: '' }`.
- `parseReady`: `'ready\t/run/user/1000/claude-code-askpass/s1'` → that path; `'12\tx'` → `null`.
- `parseRequest`: `'4242\t[sudo] password for alice: '` → `{ helperPid: 4242, prompt: '[sudo] password for alice: ' }`; `'abc\tx'`, `''`, `'0\tx'` → `null`.
- `parseHelperPs`: `'  4100 /bin/sh /opt/p/bin/askpass [sudo] password: '` → `{ ppid: 4100, args: '/bin/sh /opt/p/bin/askpass [sudo] password: ' }`; `''` → `null`.
- `isOurHelper`: true for the args above with `/opt/p/bin/askpass`; false for `/bin/sh /tmp/evil.sh` and for `/bin/sh /opt/p/bin/askpass-evil x`.
- `parseParentPs`: `'root     sudo            sudo apt update'` → `{ pid: 4100, isSudo: true, comm: 'sudo', command: 'sudo apt update' }`; `'root /usr/bin/sudo sudo -v'` → `isSudo: true` (macOS path); `'alice ssh ssh -T git@github.com'` → `isSudo: false`; `'alice sudo sudo x'` → `isSudo: false` (not root); a 300-char command → length 201 ending in `…`.
- `shouldMask`: `(true, 'anything')` → true; `(false, "Username for 'https://github.com': ")` → false; `(false, 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ')` → false; `(false, '[sudo] Passwort für alice: ')` → true; `(false, 'Enter PIN: ')` → true.
- `applyMaskedInput`: `('', 'a')` → `'a'`; `('ab', '••c')` → `'abc'`; `('abc', '••')` → `'ab'`; paste `('ab', '••xyz')` → `'abxyz'`; `('abc', '')` → `''`.
- `AnsweredPids`: `mark(7, 0)`; `has(7, 599_999)` → true; `has(7, 600_001)` → false; `has(8, 0)` → false.

- [ ] **Step 2: Run to verify they fail**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin test .'`
Expected: FAIL (module `./core` not found). If `claude plugin test` needs the manifest, write the Task 4 Step 1 manifest files first.

- [ ] **Step 3: Implement `hooks/core.ts`**

`isOurHelper`: true when `args` contains `askpassPath` followed by a space or end of string. `parseParentPs`: split on whitespace for user and comm, the rest (after the second field) is `command`. `shouldMask`: `isSudo || !(/^Username for '/.test(prompt) || /\(yes\/no/.test(prompt))`. `applyMaskedInput`: if `shown.length > real.length` return `real + shown.slice(real.length)`, else `real.slice(0, shown.length)`.

- [ ] **Step 4: Run tests**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin test .'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/core.ts hooks/core.test.ts
git commit -m "feat: add request parsing, verification and masking logic"
```

---

### Task 4: Mod lifecycle (serve process and env)

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/lifecycle.test.ts`

**Interfaces:**
- Consumes: `splitLines`, `parseReady` (Task 3); `bin/askpass --serve` (Task 2).
- Produces (inside `register.tsx`, used by Task 5): `onRequestLine(line: string): void` — the hook point where each serve output line after `ready` is delivered; module variables `askpassPath: string`, `sessionDir: string`.

- [ ] **Step 1: Write manifests**

`.claude-plugin/plugin.json`: `{ "name": "claude-code-askpass", "version": "0.1.0", "description": "Answer sudo/ssh askpass prompts from Claude's Bash commands with an in-app password pane", "license": "MIT" }`. `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`.

- [ ] **Step 2: Write failing tests in `hooks/lifecycle.test.ts`**

Fake the serve process with a test hook beneath: `on('process.spawn', async function* ($, e) { ... })` yielding `{ stream: 'stdout', text: 'ready\t/run/user/1000/claude-code-askpass/S\n' }` then awaiting a promise the test controls. Capture `env.set`, `ui.toast`, `process.run` and `command.register` with hooks beneath. Fire `$.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })`.
- `session.start spawns serve with the session id`: spawn argv is `[<root>/bin/askpass, '--serve', <$.session.id()>]`.
- `sets askpass env after ready`: `env.set` called with `CC_ASKPASS_DIR` = `/run/user/1000/claude-code-askpass/S`, `SUDO_ASKPASS` and `SSH_ASKPASS` = `<root>/bin/askpass`, `SSH_ASKPASS_REQUIRE` = `force`.
- `sets DISPLAY only when unset`: with `env.get('DISPLAY')` answering `undefined` → `DISPLAY` set to `:0`; answering `:1` → no `DISPLAY` set.
- `no ready in 5 s toasts and sets nothing`: spawn yields nothing; advance the mocked clock 5000 ms → one toast, no `env.set`.
- `serve exit unsets env`: end the fake spawn → `env.set(name, undefined)` for the four askpass vars, `DISPLAY` unset only in the case where the mod set it; one toast.
- `session.start twice re-sets env`: second start spawns again and sets env again.
- `session.end removes the session dir`: `process.run` called with `['rm', '-rf', '/run/user/1000/claude-code-askpass/S']`.
- `registers /askpass as immediate`: `command.register` input has `name: 'askpass'`, `immediate: true`.

- [ ] **Step 3: Run to verify they fail**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin test .'`
Expected: FAIL.

- [ ] **Step 4: Implement the lifecycle in `hooks/register.tsx`**

`session.start`: `await next(e)` first, then start the serve loop in a detached `void (async () => { ... })()` (the pattern in the `$.process.spawn` doc). Buffer with `splitLines`; the first line goes through `parseReady`; later lines go to `onRequestLine` (a no-op stub until Task 5). A 5 s `$.clock.after` guards `ready`. When the loop ends without the module unloading, run the unset path. Track `didSetDisplay`. `session.end`: `rm -rf` the session dir, then `next(e)`.

- [ ] **Step 5: Run validate and tests**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin validate . && claude plugin test .'`
Expected: validate lists the five env names and no refusals; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json hooks/hooks.json hooks/register.tsx hooks/lifecycle.test.ts
git commit -m "feat: start askpass listener and inject env per session"
```

---

### Task 5: Request handling and the password pane

**Files:**
- Modify: `hooks/register.tsx`
- Create: `hooks/pane.test.ts`

**Interfaces:**
- Consumes: everything in Task 3; `onRequestLine`, `askpassPath`, `sessionDir` from Task 4.
- Produces: final behavior; no new exports.

- [ ] **Step 1: Write failing tests in `hooks/pane.test.ts`**

Reuse the Task 4 fake serve; push request lines into it. Answer `process.run` beneath by argv: `ps -o ppid=,args= -p <pid>` and `ps -o user=,comm=,args= -p <ppid>` with canned output; `kill -0 <pid>` with exit 0 (alive) or 1 (gone); the reply `sh -c ...` call recorded with its `stdin`. Mount with `$.ui.mount({ surface, component: 'Pane', props: { requestId: 'askpass' } })` and loop each UI test over `['terminal', 'desktop'] as const`.
- `sudo request opens titled pane`: `ui.open` called with `id: 'askpass'`, `focus: true`, `closeOnEscape: true`; drawing contains `sudo password` and `sudo apt update`.
- `reply stdin is password plus newline`: input `'  p@ss \\w$rd é '` via `kind: 'change'` steps then submit → reply call argv is `['sh', '-c', '[ -p "$1" ] || exit 1; exec 3<>"$1"; cat >&3', '_', '<dir>/reply.4242']` and `stdin` is the password + `'\n'`.
- `masks sudo input`: after `change` with `'•••x'` following three typed chars, drawn Input `value` is `'••••'`.
- `toggle shows plain text`: press `toggle` → Input `value` equals the real text.
- `git username is not masked`: other request with prompt `Username for 'https://github.com': ` → drawn value is plain; title contains `Password requested by git`.
- `forged request is rejected`: helper args `/bin/sh /tmp/evil.sh` → no `ui.open`, no reply call, one toast containing `Rejected forged askpass request`.
- `retry shows sorry hint`: answer sudo pid 4100 once, then a new request whose parent is 4100 → drawing contains `Sorry, try again`.
- `escape replies empty line`: fire `ui.close` for `askpass` with kind `person` → reply `stdin` is `'\n'`.
- `queue serves in order`: two requests → second pane appears only after the first submit.
- `skips a queued request whose helper is gone`: second helper's `kill -0` returns 1 → after the first submit, no pane for it.
- `closes pane when helper dies`: while open, `kill -0` starts returning 1; advance clock 2000 ms → `ui.close` for `askpass`.
- `narrow terminal falls back to /askpass`: `ui.open` answers `{ isPlaced: false, reason: '...' }` → `ui.status` text `sudo is waiting for a password — type /askpass` and one toast; `command.run` for `askpass` → `ui.open` again; status cleared when the request ends.
- `/askpass with nothing pending`: toast `No pending password request`.
- `password never leaks`: across the cases above, no `ui.toast`, `ui.status` or `ui.log` text contains the test password.

- [ ] **Step 2: Run to verify they fail**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin test .'`
Expected: FAIL.

- [ ] **Step 3: Implement in `hooks/register.tsx`**

`onRequestLine` → `parseRequest` → verify with two `ps` calls (`parseHelperPs`, `isOurHelper`, `parseParentPs`) → push onto a queue. `showNext()`: pop until a request whose `kill -0` succeeds; open the pane; start a `$.clock.every(2000, …)` alive check (stop it via the returned function). Pane state in module variables (`current`, `real`, `isMasked`, `isRetry`); redraw with `$.ui.invalidate("ui.render")`, never `$.state`. Render with elements from `$.ui.resolve(e)`: title line, `command`, prompt, `Input key="password" autoFocus value={isMasked ? '•'.repeat(real.length) : real}`, `Button key="toggle"` labelled `Show`/`Hide`. `onInput` → `real = isMasked ? applyMaskedInput(real, v) : v`. Submit → reply, `answered.mark(pid)` for sudo, clear `real`, close, `showNext()`. `ui.close` with kind `person` → reply `''`, advance. `command.run` `askpass` → open pane if a request is current, else the toast. Use `answered.has(parent.pid)` to set `isRetry`.

- [ ] **Step 4: Run validate and tests**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin validate . && claude plugin test .'`
Expected: all PASS.

- [ ] **Step 5: Type-check**

Run: `wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && npx -y -p typescript tsc -p .'` (after the engine has laid `.claude-plugin/types/` by loading the mod once with `claude --plugin-dir .`; create `tsconfig.json` extending `./.claude-plugin/types/tsconfig.json` as that file's header describes; add `.claude-plugin/types/` to `.gitignore`).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add hooks/register.tsx hooks/pane.test.ts tsconfig.json .gitignore
git commit -m "feat: verify requests and answer them from a password pane"
```

---

### Task 6: Docs, marketplace, and manual end-to-end check

**Files:**
- Create: `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `LICENSE`, `.claude-plugin/marketplace.json`

- [ ] **Step 1: Write `.claude-plugin/marketplace.json`** listing one plugin `claude-code-askpass` with `"source": "./"`. Check the exact schema with `claude plugin validate .`.

- [ ] **Step 2: Write `LICENSE`** (MIT, current year 2026, copyright holder as the human specifies; ask if unknown).

- [ ] **Step 3: Write `README.md`** (English) with sections: what it does; install (`claude plugin marketplace add <repo URL>`, `claude plugin install claude-code-askpass@<marketplace>`); how it works (one diagram from spec §4); optional sudoers `Defaults:<user> timestamp_type=global` for ask-once behavior; limitations (spec §2 out-of-scope table, masking limitation or fallback per Task 1, same-uid limitation from spec §7, fake `DISPLAY` side effect, macOS untested); uninstall. Top line links: `English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)`.

- [ ] **Step 4: Write `README.zh-TW.md` and `README.zh-CN.md`**: same structure and content, same top link line with the current language unlinked.

- [ ] **Step 5: Manual end-to-end check (needs the human)** in WSL with `claude --plugin-dir /mnt/e/PhpstormProjects/claude-code-askpass`:
`sudo apt update` → pane, success; wrong password then right → "Sorry, try again" then success; Esc → sudo "no password was provided"; a `sudo` with Bash timeout 10 s left unanswered → pane closes; terminal under 110 columns → status line, `/askpass` opens pane; ssh key passphrase (masked); git HTTPS username (plain) and password (masked); `printf '1\tfake\n' > "$CC_ASKPASS_DIR/req"` from Claude → toast "Rejected forged askpass request".
Expected: every item behaves as described; record any deviation.

- [ ] **Step 6: Commit**

```bash
git add README.md README.zh-TW.md README.zh-CN.md LICENSE .claude-plugin/marketplace.json
git commit -m "docs: add READMEs, license and marketplace manifest"
```
