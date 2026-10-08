# Native Windows, and showing callers instead of judging them — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mod runs on native Windows (ssh/git prompts from the Bash and PowerShell tools, remote sudo over a second ssh connection), and on every platform the pane shows who asks (`Asked by:`) instead of silently rejecting callers.

**Architecture:** On Windows one C# program, `win/cc-askpass.cs`, is compiled on the user's machine by Windows PowerShell's `Add-Type` into `win/out/<hash>/cc-askpass.exe` (listener, askpass, reply) and a copy `shim/ssh.exe` (ssh wrapper). The listener serves a user-only named pipe, learns each client's pid from the kernel, and prints one JSON line per request; the mod decides only what `Asked by:` says, and answers through a short-lived `reply` process. Remote prompts reuse A's remote side (`bin/remote.sh`) over two plain connections: R carries the setup and the relay on its stdin/stdout, C runs the command. Linux/macOS keep their FIFO design; the trust rules are removed there too.

**Tech Stack:** C# 5 for .NET Framework 4.8 (built-in compiler via `Add-Type`), Win32 P/Invoke; POSIX sh; Claude Code Mods API (TypeScript/TSX, `claude-code/testing`); Windows PowerShell 5.1 for the build and Windows tests.

**Spec:** `docs/superpowers/specs/2026-10-08-native-windows-design.md` (changes `2026-10-05-claude-code-askpass-design.md` and `2026-10-07-remote-sudo-over-ssh-design.md`; read §12 there)

## Global Constraints

- Code comments, logs, errors and UI copy in English; README in English, 繁體中文 and 简体中文.
- The password is never in an argument list, a file other than a reply FIFO, an environment variable, the model's context, logs, toasts or status — on any platform or host.
- No component runs anything through `cmd.exe`; askpass on Windows is an `.exe`.
- The repository holds no binaries: `win/out/` is in `.gitignore`.
- Windows detection: `$.env.get('OS') === 'Windows_NT'`. Linux/macOS/WSL code paths change only by Task 2–3 (show, don't judge).
- Build: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <root>\win\build.ps1 <source> <out dir>`, 60 s timeout; `<hash>` = 64-bit FNV-1a of the source text, 16 lowercase hex digits.
- Pipe names: `cc-askpass-<session id>-<Claude Code pid>` and the same plus `-reply`; user-only ACL; the first instance created with `FILE_FLAG_FIRST_PIPE_INSTANCE`.
- Listener ready line: `ready\t<pipe name>\t<token>`, token 32 lowercase hex digits from a CSPRNG. Output UTF-8, `\n`.
- Windows env set on ready: `CC_ASKPASS_PIPE`, `SSH_ASKPASS` (= `<out>\cc-askpass.exe`), `SSH_ASKPASS_REQUIRE=force`, `CC_ASKPASS_EXCLUDE`, `CC_ASKPASS_WRAP` (as on Linux). Not `SUDO_ASKPASS`, `DISPLAY`, `CC_ASKPASS_DIR`.
- Timeouts: askpass pipe reach 5 s; askpass overall 600 s; listener pipe-creation retry 5 s; R ready line 60 s; existing values unchanged.
- Copy fixed by the spec: `Asked by: …`; unverified warning `This request did not come through cc-askpass's helper. Answer only if you know which program is asking.`; build failure toast `cc-askpass: could not build the Windows helper: <reason>` (no README link).
- Dev/test commands: Linux suite `MSYS_NO_PATHCONV=1 wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && claude plugin validate . && claude plugin test . && sh tests/ssh.sh && sh tests/askpass.sh'`; Windows suite (Git Bash on this machine) `claude plugin validate . && claude plugin test . && powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1`; types `npx -y -p typescript@5 tsc -p .`.
- sh files: POSIX, `sh -n` clean, executable in git, LF.

## Review Focus

1. Non-ASCII everywhere on Windows — a plugin path, prompt and password with CJK characters — survives pipe, JSON and stdout → Task 5 `non-ASCII path, prompt and password`.
2. A password with JSON/shell/cmd metacharacters, a tab, and spaces at both ends reaches ssh byte-exact, locally and through R's stdin → Task 5 `password round-trips exactly`, Task 4 `reply keeps tabs and edge spaces`.
3. Two Claude Code sessions at once on Windows never see each other's requests → Task 5 `two listeners keep their requests apart`.
4. The user's ssh arguments (spaces, quotes, `*`, empty strings, backslashes before quotes) reach the real ssh unchanged through the wrapper → Task 7 `arguments reach the real ssh unchanged`.
5. Killing the wrapper (Bash tool timeout) leaves no ssh process behind → Task 7 `killing the wrapper ends both connections`.

---

### Task 1: Verify the open points (spec §11)

Throwaway probes; the deliverable is the spec's §11 rewritten as findings. Nothing here is kept in `win/` or `hooks/`.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-native-windows-design.md` (§11)

- [ ] **Step 1: PATH conversion in the Bash tool snapshot.** In a dev mod under `~/.claude/dev-mods/<session id>/` (see the plugin-authoring skill), a `session.start` hook that prepends a test directory with `;` before `next(e)`; start a fresh session with `claude --plugin-dir <mod> -p "Run in the Bash tool: echo \"$PATH\" | tr ':' '\n' | head -3; type -a ssh"`. Expected: the test directory, converted to `/c/...` form, first.
- [ ] **Step 2: Shim precedence.** Put a compiled `ssh.exe` (any console exe printing `shim`) in that directory; in the same kind of session ask Claude to run `ssh -V` in both the Bash and the PowerShell tool. Expected: `shim` both times.
- [ ] **Step 3: Cygwin wildcard expansion.** From a native process (PowerShell `Start-Process -NoNewWindow -Wait` or a C# launcher), start `C:\Program Files\Git\usr\bin\ssh.exe -G "*" "a*b"` with every argument quoted. Expected: `ssh -G` prints `host *` resp. `host a*b`, not file names.
- [ ] **Step 4: ARM64.** If an ARM64 Windows machine is available, build and run the Task 5 smoke test there; otherwise record "untested".
- [ ] **Step 5: Rewrite §11 as findings, delete the dev mod, commit.**

```bash
git add docs/superpowers/specs/2026-10-08-native-windows-design.md
git commit -m "docs: record the Windows verification results"
```

If Step 1 or 2 fails, stop and bring it to the human: §5.3 depends on them.

---

### Task 2: Show, don't judge — local requests on Linux/macOS (`hooks/core.ts`, `hooks/register.tsx`)

**Files:**
- Modify: `hooks/core.ts`, `hooks/register.tsx`
- Test: `hooks/core.test.ts`, `hooks/pane.test.ts`

**Interfaces:**
- Produces (core.ts):
  ```ts
  export type AskSource =
    | { kind: 'program'; exe: string }
    | { kind: 'relay'; host: string; realSsh: string | null }
    | { kind: 'unverified'; exe: string | null }
  export function askedByLine(source: AskSource): string
  // Requester gains:  askedBy: AskSource
  ```
  `askedByLine`: program → `exe`; relay → `cc-askpass ssh wrapper → <host>` plus ` (<realSsh>)` when set; unverified → `<exe> (unverified)`, or `unknown program (unverified)` when `exe` is null.
- Removed from core.ts: `ASKPASS_CLIENTS`, `COMM_LENGTH`, `isTrustedClient`, `relayWrapperHost`, `wrapperTarget`, `SHELLS`, `SSH_OPTIONS`, `hostName` (and their tests). `parseExeInfo`/`ExeInfo` stay (the exe path).
- `Request.helperPid` is renamed `id` throughout `register.tsx` and the tests (Task 6 reuses it for the listener's request id).

- [ ] **Step 1: Write the failing core test** in `hooks/core.test.ts`:

```ts
test('askedByLine names the program, the wrapper or an unverified caller', () => {
  expect(askedByLine({ kind: 'program', exe: '/usr/bin/sudo' })).toBe('/usr/bin/sudo')
  expect(askedByLine({ kind: 'relay', host: 'server', realSsh: null })).toBe('cc-askpass ssh wrapper → server')
  expect(askedByLine({ kind: 'relay', host: 'server', realSsh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' }))
    .toBe('cc-askpass ssh wrapper → server (C:\\Windows\\System32\\OpenSSH\\ssh.exe)')
  expect(askedByLine({ kind: 'unverified', exe: null })).toBe('unknown program (unverified)')
  expect(askedByLine({ kind: 'unverified', exe: 'C:\\x\\evil.exe' })).toBe('C:\\x\\evil.exe (unverified)')
})
```

Delete the `wrapperTarget`, `relayWrapperHost` and `isTrustedClient` tests.

- [ ] **Step 2: Rewrite the pane tests** in `hooks/pane.test.ts`:
  - `forged request is rejected` → `a request not from our helper shows as unverified`: `request(6666, 6000, SUDO_PROMPT, SUDO_PARENT, { helperArgs: '/bin/sh /tmp/evil.sh x' })` opens one pane; it contains `Asked by: unknown program (unverified)` and the unverified warning; no toast contains `Rejected`; Enter with a password replies to `reply.6666`.
  - `rejects askpass run straight from a shell` → `askpass run from a shell shows the shell`: `request(7000, 6900, SUDO_PROMPT, 'alice bash bash -c x', { exe: '1000 /usr/bin/bash' })` opens a pane with `Asked by: /usr/bin/bash`.
  - `rejects a client binary not owned by root` → `a user-owned client shows its path`: pane with `Asked by: /tmp/ssh`.
  - New `sudo shows its executable`: default stage → `Asked by: /usr/bin/sudo`; with exe-of failing (no `exes` entry; add an `exe: null` option to `stage` that skips setting it) → `Asked by: sudo (root)`.
  - `rejects a relay with a forged wrapper path` → `a relay script outside the plugin shows as a program`: pane opens, `Asked by: /usr/bin/dash`, no `remote` tag.
  - The `rejects a relay whose parent is not the wrapper …` loop → one test `a relay is labelled by its own host argument`: for each of the three `wrapperArgs`, the pane opens with `Asked by: cc-askpass ssh wrapper → server`.
  - `accepts a request relayed by the ssh wrapper`: also expects `Asked by: cc-askpass ssh wrapper → server`.
  - `rejects relayed requests with remoteHosts off`: unchanged (still answered empty).

- [ ] **Step 3: Run to see them fail**

Run the Linux suite (Global Constraints). Expected: the new and rewritten tests FAIL (`askedByLine` missing, panes not opened).

- [ ] **Step 4: Implement**
  - core.ts: `AskSource`, `askedByLine`, `Requester.askedBy`; delete the removed functions.
  - register.tsx `verify`: when `isOurHelper` fails, build an unverified requester (`pid: id`, `isSudo: false`, `comm: 'unknown program'`, `command: helper.args`, `askedBy: { kind: 'unverified', exe: null }`) and queue it. Otherwise read the parent as today; a relay (`relayHost` non-null) gets `{ kind: 'relay', host, realSsh: null }` and keeps today's `remoteHosts`-off empty answer; any other parent gets `{ kind: 'program', exe }` with `exe` from `bin/exe-of`, falling back to `sudo (root)` for sudo and to `comm` otherwise. Delete `isTrustedCaller`, `isWrapperRelay` and the two `Rejected …` toasts.
  - Pane: a dim `Asked by: <askedByLine>` line directly under the heading (before the `remote` tag); for `unverified`, the warning under it in red. Count both in `paneRows`.

- [ ] **Step 5: Run the Linux suite and tsc.** Expected: all pass, `TSC_OK`-clean.

- [ ] **Step 6: Commit**

```bash
git add hooks/core.ts hooks/core.test.ts hooks/register.tsx hooks/pane.test.ts
git commit -m "feat: show who asks instead of rejecting callers"
```

---

### Task 3: Show, don't judge — the remote side and the ssh wrapper (`bin/remote.sh`, `bin/shim/ssh`)

**Files:**
- Modify: `bin/remote.sh`, `bin/shim/ssh`
- Test: `tests/ssh.sh`

- [ ] **Step 1: Update the tests** in `tests/ssh.sh`: delete the `verify_case` block (lines ~338–375) and the `trusted ssh: root-owned and named ssh` block; change the "fake ssh is not root-owned" case so the command is **wrapped** (the fake ssh is used); delete the `relay refused: … is not a root-owned ssh binary` assertion; add `relay passes every request line`: with a token directory fixture, a line written to `req` from a helper pid whose parent is a plain shell appears on the relay's stdout unchanged.
- [ ] **Step 2: Run to see them fail.** Linux suite. Expected: the wrapped-fake-ssh case and the relay case FAIL.
- [ ] **Step 3: Implement.** remote.sh: delete `proc`, `exe_of`, `after`, `target_name`, `verify`; `relay` prints every well-formed line (pid field numeric) and drops the empty-reply branch; the bootstrap no longer decodes `CCAP_EXE_B64` or writes `exe-of`. bin/shim/ssh: delete `trusted_ssh` and both of its uses (pass-through rule and `relay refused`); stop sending `CCAP_EXE_B64`. Update both files' header comments.
- [ ] **Step 4: Run the Linux suite.** Expected: `PASS: all ssh wrapper tests`, `PASS: all askpass tests`, plugin tests pass.
- [ ] **Step 5: Commit**

```bash
git add bin/remote.sh bin/shim/ssh tests/ssh.sh
git commit -m "feat: relay every remote request and let the person judge it"
```

---

### Task 4: `remote.sh` modes for a connection without multiplexing

**Files:**
- Modify: `bin/remote.sh`
- Test: `tests/ssh.sh`

**Interfaces:**
- Produces:
  - `remote.sh serve-stdin <token>` (with `CCAP_RS_B64` = this file, as in A §4.4). Stdin line 1: `<askpass b64> <ssh-wrapper b64>`. Sets up the token directory exactly as the bootstrap does (base choice, sweep, `owner.pid` = this process, askpass, ssh, `remote.sh`, sudo wrapper, `req` FIFO, `relay.pid` = this process), prints `cc-askpass-ready <token dir>`, then relays request lines from `req` to stdout while a background reader takes stdin lines `<pid>\t<password>` (split at the first tab only) and writes `<password>\n` into `<token dir>/reply.<pid>` with REPLY_SCRIPT's checks. Stdin EOF or HUP/TERM: write `stop` into `req`, remove the directory, exit 0. A setup failure prints `cc-askpass-failed` instead of the ready line and exits 1.
  - `remote.sh run` with `CCAP_DIR` and `CCAP_CMD_B64`: requires `CCAP_DIR` to be an owned 0700 `cc-askpass-*` directory with `req`, else runs the command plainly; exports A's variables (`SUDO_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `CC_ASKPASS_DIR`, `CC_ASKPASS_REMOTE`, `CC_ASKPASS_WRAP`, `PATH`) and runs the command the way the bootstrap's last lines do (factor them into `run_command` shared by both).

- [ ] **Step 1: Write the failing tests** in `tests/ssh.sh` (no sshd needed: run `remote.sh` locally through a pipe, `CCAP_TEST_BASES` pointing at a temp dir):
  - `serve-stdin sets up and announces the directory`: first stdout line matches `^cc-askpass-ready <base>/cc-askpass-<token>$`; the directory is mode 700 and holds `askpass ssh sudo remote.sh req relay.pid owner.pid`.
  - `serve-stdin relays and answers`: a fake helper writes `123\tP\t\t` to `req` and opens `reply.123`; the line appears on stdout; writing `123\tpw\n` to stdin makes the helper read `pw`.
  - `reply keeps tabs and edge spaces`: stdin `123\t  a\tb  \n` → the helper reads `  a\tb  `.
  - `stdin EOF cleans up`: closing stdin removes the directory within 2 s.
  - `run uses the prepared directory`: `CCAP_DIR=<dir> CCAP_CMD_B64=$(printf 'echo "$SUDO_ASKPASS"' | base64) sh remote.sh run` prints `<dir>/askpass`.
  - `run without a valid directory runs plainly`: `CCAP_DIR=/nonexistent` → the command runs, `SUDO_ASKPASS` empty.
- [ ] **Step 2: Run to see them fail.** Linux suite. Expected: FAIL (unknown modes).
- [ ] **Step 3: Implement the two modes and `run_command`** in `bin/remote.sh`; dispatch `serve-stdin` and `run` in the final `case`.
- [ ] **Step 4: Run the Linux suite.** Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add bin/remote.sh tests/ssh.sh
git commit -m "feat: remote.sh modes for a relay over a plain connection"
```

---

### Task 5: The Windows helper — build, listener, askpass, reply (`win/`)

**Files:**
- Create: `win/cc-askpass.cs`, `win/build.ps1`, `tests/win.ps1`
- Modify: `.gitignore` (add `win/out/`)

**Interfaces:**
- Produces:
  - `build.ps1 <source> <outDir>`: compiles with `Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 <source>) -OutputAssembly <outDir>\cc-askpass.tmp.exe -OutputType ConsoleApplication`, renames to `cc-askpass.exe`, copies to `<outDir>\shim\ssh.exe`, then removes sibling directories of `<outDir>` (ignoring locked files). Exit 0, or non-zero with one-line reason on stderr.
  - `cc-askpass.exe serve <session id>`; `cc-askpass.exe reply`; `cc-askpass.exe <prompt>`; run as `ssh.exe` → wrapper (Task 7; until then it prints `cc-askpass: the ssh wrapper is not built yet` and exits 255).
  - Listener stdout lines (one per event, UTF-8):
    - `ready\t<pipe>\t<token>`
    - `{"id":N,"client":{"pid":P,"exe":"…"},"parent":{"pid":P,"exe":"…","args":"…"}|null,"ancestors":[{"pid":P,"args":"…"}],"prompt":"…","relay":null|{"host":"…","realSsh":"…","remotePid":N,"via":"…"|null,"reported":"…"|null}}`
    - `{"gone":N}` when a request connection closes before its reply.
  - Request line from askpass: `<prompt>`; from the wrapper: `relay\t<host>\t<realSsh>\t<remotePid>\t<prompt>\t<via>\t<reported>`. Reply pipe input: `<token>\t<id>\n<password>\n`.
- Internals (one file; static classes): `Native` (P/Invoke: `CreateNamedPipe` with `FILE_FLAG_FIRST_PIPE_INSTANCE` and a SECURITY_ATTRIBUTES built from a `PipeSecurity` granting the current user's SID full control, `GetNamedPipeClientProcessId`, `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `QueryFullProcessImageNameW`, `CreateToolhelp32Snapshot`/`Process32FirstW`/`Process32NextW`, `NtQueryInformationProcess` class 60), `Json` (string escaping: `"`, `\`, control characters as `\u00XX`), `Listener` (a thread per connection), `Asker`, `Replier`. `Console.OutputEncoding = new UTF8Encoding(false)`; stdout writes serialized by a lock.
- Askpass behaviour: spec §5.5 (unset `CC_ASKPASS_PIPE` → the base design's message, exit 1; 5 s reach; reconnect and resend on a broken connection; 600 s overall; empty reply → exit 1). Prompt tabs/newlines → spaces, cut to 1000 UTF-8 bytes.

- [ ] **Step 1: Write the failing test script** `tests/win.ps1` (Windows PowerShell 5.1; `$ErrorActionPreference = 'Stop'`; prints `PASS: all Windows helper tests` at the end, `FAIL: <name>` and exit 1 on the first failure). It builds into a temp directory, starts `serve` with redirected stdout, reads the ready line, then:
  - `build is idempotent and cleans siblings`: a second build into a new sibling removes the first directory.
  - `askpass reaches the pane line and returns the reply`: run `cc-askpass.exe "Enter passphrase: "`; the listener prints a JSON line whose `client.exe` is the built exe and whose `prompt` is `Enter passphrase: `; `reply` with the right token makes askpass print the password and exit 0.
  - `password round-trips exactly`: password `  p&w|"x^%!<y>\t\\é  ` (leading/trailing spaces, tab) comes back byte-identical.
  - `non-ASCII path, prompt and password`: build into a directory named `測試 dir`; prompt `密碼：`; password `пароль密碼`; all identical in the JSON line and askpass output.
  - `a prompt with quotes arrives as one argument`: `cc-askpass.exe 'a"&echo INJECTED>m&"b'` → JSON `prompt` equals it; no file `m` appears.
  - `ssh-keygen through both ssh builds`: an encrypted ed25519 key; `SSH_ASKPASS=<exe>`, `SSH_ASKPASS_REQUIRE=force`; `ssh-keygen -y` of Windows OpenSSH and (if present) Git's — answered via `reply` — prints the public key; the JSON `parent.exe` ends with `ssh-keygen.exe`.
  - `a wrong token is ignored`: reply with a wrong token; askpass is still waiting after 1 s; the right token then completes it.
  - `empty reply fails askpass`: exit code 1.
  - `gone is reported`: kill a waiting askpass; a `{"gone":N}` line for its id follows within 2 s.
  - `askpass reconnects after a listener restart`: with askpass waiting, stop and restart `serve` (same session id, same parent); answer the new JSON line; askpass prints the password.
  - `two listeners keep their requests apart`: two `serve` processes with different session ids; an askpass with each one's `CC_ASKPASS_PIPE` shows up only on its own listener.
  - `without CC_ASKPASS_PIPE askpass fails at once`: exit 1 within 1 s, stderr names the mod.
- [ ] **Step 2: Run to see it fail.** `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1`. Expected: FAIL at the build (no source).
- [ ] **Step 3: Implement `win/build.ps1` and `win/cc-askpass.cs`** as specified above; add `win/out/` to `.gitignore`.
- [ ] **Step 4: Run the Windows test script.** Expected: `PASS: all Windows helper tests`.
- [ ] **Step 5: Commit**

```bash
git add win/cc-askpass.cs win/build.ps1 tests/win.ps1 .gitignore
git commit -m "feat: Windows helper for askpass prompts over a named pipe"
```

---

### Task 6: The mod on Windows (`hooks/`)

**Files:**
- Create: `hooks/windows.ts`
- Modify: `hooks/core.ts`, `hooks/register.tsx`, `hooks/testkit.ts`
- Test: `hooks/core.test.ts`, `hooks/lifecycle.test.ts`, `hooks/pane.test.ts`

**Interfaces:**
- Consumes: Task 5's listener lines, CLI and reply input; Task 2's `AskSource`, `askedByLine`, `Request.id`.
- Produces (core.ts):
  ```ts
  export function fnv1a64(text: string): string                 // 16 lowercase hex digits
  export function withShim(path: string | undefined, dir: string, separator?: ':' | ';'): string | null
  export function parseWinReady(line: string): { pipe: string; token: string } | null
  export type WinRequest = {
    id: number
    client: { pid: number; exe: string }
    parent: { pid: number; exe: string; args: string } | null
    ancestors: { pid: number; args: string }[]
    prompt: string
    relay: { host: string; realSsh: string; remotePid: number; via: string | null; reported: string | null } | null
  }
  export function parseWinLine(line: string): WinRequest | { gone: number } | null
  export function winAskSource(request: WinRequest, helperExe: string, shimExe: string): AskSource
  ```
  `winAskSource` (paths compared case-insensitively): client is `helperExe` → `program` with `parent.exe` (or `unverified` with null when `parent` is null); client is `shimExe` and `relay` set → `relay` with `host`, `realSsh`; anything else → `unverified` with `client.exe`.
  `fnv1a64`: offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, over the UTF-16 code units of `text` taken as bytes low then high, with `BigInt` arithmetic masked to 64 bits.
- Produces (windows.ts): `buildHelper($: EngineInterface, root: string): Promise<{ outDir: string } | { error: string }>`; `winReply($: EngineInterface, exe: string, token: string, id: number, password: string): Promise<void>` (runs `[exe, 'reply']` with `stdin` `${token}\t${id}\n${password}\n`, 5 s timeout, logs failures).
- register.tsx: a module-level `isWin`; `reply`, `isRequestAlive`, `findClaudeCommand`, `setEnv`, `unsetEnv`, `runServe`, `session.start`, `session.end` and `prompt.compose` branch on it. `isRequestAlive` on Windows: the id is not in a `goneIds` set (no `kill -0`). Windows `Requester`: `pid` = client pid, `comm` = parent exe basename without `.exe`, `command` = `parent.args`, `isSudo: false`, `remote` from `relay` (`via`/`reported` cleaned as today).
- Bash on Windows (spec §5.3, §11): in `session.start` before `next(e)` also set `BASH_FUNC_ssh%%` to `() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "<shim ssh.exe with forward slashes>" "$@"
}` (a reload sets it again; never unset). Lifecycle test `Windows defines the bash ssh function`: the env value equals that string with `<root>/win/out/<hash>/shim/ssh.exe` in forward slashes.
- `Claude ran:` on Windows: first try `matchBashCommand` over each ancestor's args; otherwise, if an ancestor's args contain `$__claudeCodeScript` and exactly one PowerShell tool call is in progress, that call's command. Track PowerShell calls in `on('tool.call', { tool: 'PowerShell' }, …)`: add before `await next(e)`, remove after (also on throw). Record Bash calls on Windows as today.
- Windows system prompt note (exact copy): `ssh and git can ask the user for a password or key passphrase in this session: the cc-askpass plugin shows a prompt inside Claude Code. Run them normally and do not ask the user to type passwords themselves.` plus `REMOTE_NOTE` when remote prompts are on.

- [ ] **Step 1: Write the failing core tests**: `fnv1a64('') === 'cbf29ce484222325'` and `fnv1a64('a') === '089be207b544f1e4'` (bytes `61 00`); `withShim('C:\\a;C:\\b', 'C:\\s', ';') === 'C:\\s;C:\\a;C:\\b'` and `null` when present; `parseWinReady('ready\tcc-askpass-S-900\t' + 'a'.repeat(32))` parses, a 31-digit token does not; `parseWinLine` of a full JSON line, of `{"gone":3}`, and `null` for `garbage` and for JSON missing `id`; `winAskSource` for the three cases, including a client path differing only in case.
- [ ] **Step 2: Write the failing lifecycle tests** (in `hooks/lifecycle.test.ts`; extend `testkit.ts` with a `windowsWorld` option that answers `$.env.get('OS')` with `Windows_NT`, `$.fs.read` of the source with fixed text, and `$.fs.exists` from a set):
  - `Windows builds the helper only when missing`: exists → no build run; missing → one `process.run` whose argv is the Global Constraints build command with `<root>\win\build.ps1`.
  - `Windows puts the shim first with ;`: PATH becomes `<root>\win\out\<hash>\shim;<old PATH>`.
  - `Windows starts the listener from the built exe`: spawn argv `[<out>\cc-askpass.exe, 'serve', SESSION_ID]`.
  - `Windows sets its env on ready`: after `ready\t<pipe>\t<token>`, `CC_ASKPASS_PIPE`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `CC_ASKPASS_WRAP` set; `SUDO_ASKPASS`, `DISPLAY`, `CC_ASKPASS_DIR` never set.
  - `a failed build toasts and changes nothing`: build exits 1 with stderr `Add-Type is blocked` → toast `cc-askpass: could not build the Windows helper: Add-Type is blocked`; no PATH, no spawn, no env.
  - `Windows system prompt note covers ssh only`.
- [ ] **Step 3: Write the failing pane tests** (Windows world emitting JSON lines):
  - `a Windows request shows the asking program`: client = helper exe, parent `C:\Windows\System32\OpenSSH\ssh.exe` → pane heading `ssh (pid …) needs a password`, `Asked by: C:\Windows\System32\OpenSSH\ssh.exe`.
  - `a Windows reply goes through the helper`: Enter `PASSWORD` → one run `[<exe>, 'reply']` with stdin `${token}\t${id}\n${PASSWORD}\n`; no `sh` run.
  - `a direct pipe client shows as unverified`: client `C:\x\evil.exe` → `Asked by: C:\x\evil.exe (unverified)` and the warning.
  - `a Windows relay shows the wrapper and the real ssh`: client = shim exe with `relay` → `remote` tag, `Asked by: cc-askpass ssh wrapper → server (C:\Windows\System32\OpenSSH\ssh.exe)`.
  - `gone closes the pane`: `{"gone":id}` → pane closed, no reply run.
  - `Claude ran from a single PowerShell call`: a PowerShell tool call in progress, ancestor args containing `$__claudeCodeScript` → `Claude ran: <that command>`; with two calls in progress → no Claude line.
  - `password never leaks on Windows`: as the Linux test, over toasts, logs, status and env sets.
- [ ] **Step 4: Run to see them fail.** Windows suite (`claude plugin test .`). Expected: FAIL.
- [ ] **Step 5: Implement** core.ts additions, `hooks/windows.ts`, and the register.tsx branches above. The build runs before `next(e)` in `session.start` (it must precede the Bash snapshot's PATH); a missing source file counts as a failed build.
- [ ] **Step 6: Run the Windows suite, the Linux suite and tsc.** Expected: all pass.
- [ ] **Step 7: Commit**

```bash
git add hooks/core.ts hooks/core.test.ts hooks/windows.ts hooks/register.tsx hooks/testkit.ts hooks/lifecycle.test.ts hooks/pane.test.ts
git commit -m "feat: run the mod on native Windows"
```

---

### Task 7: The Windows ssh wrapper (`win/cc-askpass.cs`)

**Files:**
- Modify: `win/cc-askpass.cs`
- Test: `tests/win.ps1`

**Interfaces:**
- Consumes: Task 4's `serve-stdin`/`run` protocol; Task 5's relay request line and pipe client code.
- Produces: `ssh.exe <args>` behaviour per spec §6:
  - `FindRealSsh()`: first `ssh` + PATHEXT match on `PATH` whose directory is not the wrapper's own (case-insensitive, full-path compare). None → `cc-askpass: ssh: command not found`, exit 255.
  - `ShouldWrap(args, env)`: a C# port of `should_wrap`/`parse_args` from `bin/shim/ssh` (same option string, pass-through flags, protocol commands, `excludeHosts` globs from `CC_ASKPASS_EXCLUDE`, `CC_ASKPASS_WRAP`, `SSH_ASKPASS` equal to the helper beside the wrapper, pipe reachable). Also passes through when the base64 command would push C's command line over 32,767 characters.
  - `QuoteArg(string)`: the standard Windows rule — wrap in `"`; a run of backslashes followed by `"` doubles and the `"` becomes `\"`; a run at the end doubles; every argument quoted, empty ones as `""`.
  - Pass-through: start the real ssh with the original arguments, inherited handles, wait, exit with its code.
  - Wrapped: create a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; start R (`<options and host> <A §4.4 one-liner running remote.sh serve-stdin <token>>`, stdin/stdout redirected, stderr inherited); write the payload line; wait ≤ 60 s for `cc-askpass-ready <dir>` (anything else, exit, timeout → kill R, pass through); start C with the command replaced by `env CCAP_DIR=<dir> CCAP_CMD_B64=<b64> /bin/sh <dir>/remote.sh run`, handles inherited; a thread turns each R line into a relay request on the pipe and writes `<remotePid>\t<reply>\n` to R's stdin; when C exits close R's stdin, wait ≤ 5 s for R, exit with C's code.
  - Token: 32 hex digits from a CSPRNG. `remote.sh`, `bin/askpass` and `bin/shim/ssh` are read from the plugin root (two levels above `win\out\<hash>\shim`).

- [ ] **Step 1: Write the failing tests** in `tests/win.ps1`, using a fake real ssh (a second tiny C# console exe built by the test, placed in a temp `fakebin` after the shim directory on `PATH`, that writes its arguments as JSON to a file and runs a script given by `FAKE_SSH_MODE`):
  - `wrap decisions match the sh wrapper`: the decision table from `tests/ssh.sh` (`expect_decision` cases), each run through `ssh.exe` with the fake ssh in `record` mode → wrapped cases started R (first recorded argv carries `serve-stdin`), pass-through cases recorded exactly the original arguments.
  - `arguments reach the real ssh unchanged`: pass-through of `-o "User a b"`, `"*"`, `""`, `a\\"b`, `trailing\\` → the recorded argv equals the input.
  - `remoteHosts off passes through`: `CC_ASKPASS_WRAP` unset → original arguments.
  - `a host that never says ready runs unwrapped`: fake ssh in `silent` mode for R → after the timeout (set `CC_ASKPASS_TEST_READY_MS=500` for the test; the wrapper honours it only when non-empty) the original command runs once.
  - `relay request reaches the listener and the answer reaches R`: fake ssh in `relay` mode prints the ready line, then `77\t[sudo] password for bob: \t\tsudo true`; the listener prints a JSON line with `client.exe` = the shim and `relay.host` = `server`; after `reply`, the fake ssh's stdin receives `77\t<password>`.
  - `killing the wrapper ends both connections`: fake ssh in `sleep` mode for R and C; kill the wrapper; within 2 s no fake-ssh process remains.
  - `no real ssh fails with 255`: `PATH` without any ssh → exit 255, stderr `cc-askpass: ssh: command not found`.
  - Optional end-to-end when `CC_ASKPASS_TEST_SSH` names a host (`user@127.0.0.1 -p 2299` with a key, e.g. a WSL user sshd): `ssh.exe <host> 'echo ok'` prints `ok`, and `ssh.exe <host> 'printf %s "$SUDO_ASKPASS"'` prints a `cc-askpass-` path.
- [ ] **Step 2: Run to see them fail.** `tests/win.ps1`. Expected: FAIL (wrapper not built yet).
- [ ] **Step 3: Implement** the wrapper in `win/cc-askpass.cs`.
- [ ] **Step 4: Run the Windows suite.** Expected: `PASS: all Windows helper tests`; with a WSL sshd and `CC_ASKPASS_TEST_SSH` set, the end-to-end cases pass too.
- [ ] **Step 5: Commit**

```bash
git add win/cc-askpass.cs tests/win.ps1
git commit -m "feat: Windows ssh wrapper relays remote prompts over a second connection"
```

---

### Task 8: READMEs and CI

**Files:**
- Modify: `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: READMEs (all three, same content).** Platforms line becomes Linux, WSL, macOS or Windows (Git for Windows optional). New `Windows` section: what is built on first start (from source, no binaries shipped), where (`win/out`), that machines blocking `Add-Type` or unsigned programs keep the mod off with a toast, that remote logins by password are asked twice per command. Security section rewritten per spec §9: any program running as you can raise the pane; read `Asked by:` and `Claude ran:`; the Linux/macOS pid race; Windows kernel pid. Remove the old trust wording ("only sudo and root-owned ssh/git binaries …") and A's residual-risk paragraph.
- [ ] **Step 2: CI.** Add `windows-latest` to the matrix; on Windows run validate, plugin test and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1`, and skip `tests/askpass.sh`/`tests/ssh.sh` (`if: runner.os != 'Windows'`).
- [ ] **Step 3: Run `claude plugin validate .`.** Expected: passes. The workflow runs once the repository is on GitHub.
- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-TW.md README.zh-CN.md .github/workflows/ci.yml
git commit -m "docs: Windows support and the new request model; CI on Windows"
```

---

### Task 9: Manual end-to-end (human at the keyboard)

The human types every password; the agent never does.

- [ ] **Step 1: Windows, this machine.** Start a user sshd in WSL on port 2299 with password and key logins for a test user; load the plugin with `claude --plugin-dir E:\PhpstormProjects\claude-code-askpass`. In both the Bash and the PowerShell tool: an encrypted key's `ssh -i key … true` (passphrase pane, `Asked by:` the right ssh.exe); a password login (pane, twice when wrapped); `ssh host sudo true` (remote pane; `Asked by: cc-askpass ssh wrapper → …`); a script on the host calling sudo; Ctrl+C during a waiting prompt leaves no `ssh.exe` and no remote `cc-askpass-*` directory; editing a hook file (reload) while a prompt waits brings the prompt back.
- [ ] **Step 2: Linux sanity (WSL) and macOS VM.** `sudo -k && sudo true`, an askpass call from a plain shell (`$SUDO_ASKPASS x` shows `Asked by: /usr/bin/bash` — answer Cancel), and `ssh mac sudo true` from WSL.
- [ ] **Step 3: Record results** in the spec's status line and commit.

```bash
git add docs/superpowers/specs/2026-10-08-native-windows-design.md
git commit -m "docs: Windows end-to-end results"
```
