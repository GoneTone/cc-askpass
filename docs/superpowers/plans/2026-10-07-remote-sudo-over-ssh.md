# Remote password prompts over ssh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Password prompts raised on a host Claude reached over ssh (sudo, nested sudo, further hops) are answered in the same pane, without breaking ssh to hosts that cannot take part.

**Architecture:** A `tool.call` hook prefixes Claude's Bash commands with a PATH entry holding one file, `bin/shim/ssh`. The wrapper opens an ssh master, probes the host, and runs the command wrapped in a bootstrap (`bin/remote.sh`) that installs askpass, a `sudo -A` wrapper and the ssh wrapper itself in a 0700 token directory on the remote host. A relay session over the same master carries request lines back; the wrapper hands each to `$SSH_ASKPASS` (the plugin's `bin/askpass` locally), so the mod sees a helper whose parent is the wrapper in relay mode, and the answer goes back on the stdin of a third session.

**Tech Stack:** POSIX sh; OpenSSH client (multiplexing) and, for tests, an unprivileged `sshd`; Claude Code Mods API 2.1.289 (TypeScript/TSX, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-10-07-remote-sudo-over-ssh-design.md` (extends `docs/superpowers/specs/2026-10-05-claude-code-askpass-design.md`)

## Global Constraints

- Code comments, logs, errors and UI copy in English; README in English, 繁體中文 and 简体中文.
- `bin/shim/ssh`, `bin/remote.sh`, `bin/askpass`: POSIX sh, `sh -n` clean, committed executable (`git update-index --chmod=+x`), LF.
- `bin/shim/` contains only `ssh`.
- The wrapper and the bootstrap never write to stdout; diagnostics go to stderr.
- The password is never in an argument list, a file other than a reply FIFO, the model's context, logs, toasts or status, on either host.
- Timeouts: probe 5 s; remote askpass watchdog 600 s (as local); existing local values unchanged.
- Remote base directories, in order: `$XDG_RUNTIME_DIR`, `$HOME/.cache`, `/tmp`; token directory `cc-askpass-<token>`, mode 0700.
- Probe success line: `cc-askpass-probe-ok`.
- Pass-through flags: `-N -W -O -s -G -V -Q -f`. Protocol commands: `git-upload-pack`, `git-receive-pack`, `git-upload-archive`, `scp -t`, `scp -f`, `rsync --server` (unless the command contains `sudo`), `borg serve`, `sftp-server`, `internal-sftp`.
- OpenSSH option string for `getopts`: `1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy`.
- Env names: `CC_ASKPASS_DIR`, `SSH_ASKPASS`, `SUDO_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `CC_ASKPASS_VIA`, `CC_ASKPASS_REPORTED`, `CC_ASKPASS_EXCLUDE` (newline-separated globs).
- Request line: `<pid>\t<prompt>[\t<via>\t<reported>]`; plain local requests keep the two-field form.
- Dev/test: WSL Ubuntu via `MSYS_NO_PATHCONV=1 wsl -e bash -lc 'cd /mnt/e/PhpstormProjects/claude-code-askpass && <cmd>'`; plugin tests `claude plugin validate . && claude plugin test .`; types `npx -y -p typescript@5 tsc -p .`.
- Prerequisite for Task 4 onwards: `openssh-server` installed on the dev machine (`sudo apt install -y openssh-server`, the human runs it); the tests start their own sshd as the user and never touch the system one.

## Review Focus

1. A remote command whose quoting must survive (`ssh h 'echo "a b" | grep -c "a b"'`, single quotes, `$VAR` meant for the remote shell, a fish login shell) runs exactly as without the wrapper → Task 4 `wrapped command keeps quoting` and `fish login shell`.
2. rsync and git over a wrapped connection stay byte-exact on stdout → Task 4 `stdout is untouched` (binary round trip through `ssh h cat`).
3. The remote command's exit status and stdin reach the caller unchanged (`echo x | ssh h 'cat; exit 7'`) → Task 4 `exit status and stdin pass through`.
4. A host where the probe fails (forced command, no `/bin/sh`) behaves exactly as unwrapped and is never left with a hanging relay → Task 4 `probe failure runs unwrapped`.
5. Killing the wrapper mid-request (Bash timeout) leaves no process locally and no token directory on the remote → Task 4 `killed wrapper cleans up`.

---

### Task 1: Request line fields and the relay requester (`hooks/core.ts`)

**Files:**
- Modify: `hooks/core.ts`
- Test: `hooks/core.test.ts`

**Interfaces:**
- Produces:
  - `parseRequest(line: string): { helperPid: number; prompt: string; via: string | null; reported: string | null } | null` (extends the existing function; two-field lines give `via: null, reported: null`).
  - `relayHost(args: string, shimPath: string): string | null` — the host from a process whose args are `<interpreter> <shimPath> --relay <host>` (or `<shimPath> --relay <host>`); `null` for anything else or a host outside `[A-Za-z0-9._@:%-]+`.
  - `remoteLabel(host: string, via: string | null): string` — `host` when `via` is null/empty, otherwise `<via without its last " via <host>" part> via <host>`; the verified `host` always ends the label.

- [ ] **Step 1: Write the failing tests** in `hooks/core.test.ts`:

```ts
test('parseRequest reads the optional via and reported fields', () => {
  expect(parseRequest('42\tPassword: ')).toEqual({ helperPid: 42, prompt: 'Password: ', via: null, reported: null })
  expect(parseRequest('42\tPassword: \tdb01\tsudo apt update')).toEqual({
    helperPid: 42, prompt: 'Password: ', via: 'db01', reported: 'sudo apt update',
  })
  expect(parseRequest('42\tPassword: \t\tsudo true')?.via).toBe(null)
})

test('relayHost accepts only the plugin wrapper in relay mode', () => {
  const shim = '/opt/p/bin/shim/ssh'
  expect(relayHost(`/bin/sh ${shim} --relay server`, shim)).toBe('server')
  expect(relayHost(`${shim} --relay alice@db-1.example.com`, shim)).toBe('alice@db-1.example.com')
  expect(relayHost(`/bin/sh ${shim} -p 22 server sudo x`, shim)).toBe(null)
  expect(relayHost(`/bin/sh /tmp/evil --relay server`, shim)).toBe(null)
  expect(relayHost(`/bin/sh ${shim} --relay server; rm`, shim)).toBe(null)
})

test('remoteLabel ends with the verified host', () => {
  expect(remoteLabel('server', null)).toBe('server')
  expect(remoteLabel('server', 'db01')).toBe('db01 via server')
  expect(remoteLabel('server', 'db01 via evil')).toBe('db01 via evil via server')
})
```

- [ ] **Step 2: Run, expect FAIL** (`relayHost`/`remoteLabel` not exported; `parseRequest` lacks `via`).

Run: `claude plugin test .` — Expected: the three new tests fail; existing `parseRequest` tests need `via: null, reported: null` added to their expected objects (update them in this step).

- [ ] **Step 3: Implement** the three functions in `hooks/core.ts`. `parseRequest` splits on tabs: field 1 pid, field 2 prompt, fields 3–4 optional; empty strings become `null`.

- [ ] **Step 4: Run, expect PASS.** Run: `claude plugin test .` — Expected: all pass.

- [ ] **Step 5: Commit** — `feat: parse relayed request fields and the relay requester`

---

### Task 2: askpass writes via/reported fields and accepts a relay listener (`bin/askpass`)

**Files:**
- Modify: `bin/askpass`
- Test: `tests/askpass.sh`

**Interfaces:**
- Consumes: request line format from Global Constraints.
- Produces: `bin/askpass <prompt>` honours `CC_ASKPASS_VIA`, `CC_ASKPASS_REPORTED` and, when `CC_ASKPASS_REMOTE=1`, fills `<reported>` itself from `ps -o args= -p $PPID`. The listener check accepts `serve.pid` or `relay.pid` in `CC_ASKPASS_DIR`.

- [ ] **Step 1: Write failing shell tests** in `tests/askpass.sh`:
  - `test_request_carries_via_and_reported`: with `CC_ASKPASS_VIA=db01 CC_ASKPASS_REPORTED='sudo  apt	update'` the request line equals `<pid>\tPassword: \tdb01\tsudo  apt update` (tab in the field became a space).
  - `test_remote_mode_reports_parent`: run askpass with `CC_ASKPASS_REMOTE=1` from `sh -c 'exec "$0" "Password: "'` started by a parent `sleep`-holding shell; the line's 4th field is that parent's args.
  - `test_relay_pid_counts_as_listener`: no `serve.pid`, a live `relay.pid` → request goes out; dead `relay.pid` → exits 1 with "listener is not running".
  - Existing two-field tests stay unchanged.
- [ ] **Step 2: Run** `sh tests/askpass.sh` — Expected: the three new tests FAIL.
- [ ] **Step 3: Implement.** Sanitise each field with the existing `tr '\t\n' '  ' | cut -c 1-1000` (reported cut to 2000 like the mod's `MAX_COMMAND_LENGTH`); append `\t<via>\t<reported>` only when either is non-empty; listener check reads `serve.pid`, else `relay.pid`.
- [ ] **Step 4: Run** `sh tests/askpass.sh` — Expected: `PASS: all askpass tests`.
- [ ] **Step 5: Commit** — `feat: askpass carries relay fields and accepts a relay listener`

---

### Task 3: ssh wrapper — argument parsing and pass-through (`bin/shim/ssh`)

**Files:**
- Create: `bin/shim/ssh`
- Create: `tests/ssh.sh` (unit section with a recording fake `ssh`)
- Modify: `.github/workflows/ci.yml` (add `sh tests/ssh.sh`)

**Interfaces:**
- Produces (used by Task 4): sh functions inside `bin/shim/ssh`:
  - `find_real_ssh` → sets `real_ssh`; exit 255 with `cc-askpass: the ssh wrapper found only itself on PATH` when PATH without the shim directory resolves to the wrapper.
  - `parse_args "$@"` → sets `opts` (the option words, re-quoted for `eval set --`), `host`, `command` (remaining words joined by single spaces, as ssh does), `pass_flag` (1 when a pass-through flag is present), `tty_opts` (`-t`/`-tt` occurrences), `caller_ctl` (from `-S path`, `-o ControlPath=path`, `-oControlPath path`, case-insensitive key).
  - `should_wrap` → returns 0 only when: listener alive (`CC_ASKPASS_DIR` with live `serve.pid` or `relay.pid`), `SSH_ASKPASS` set, `command` non-empty, `pass_flag` unset, command not a protocol command, host not matching any `CC_ASKPASS_EXCLUDE` glob.
  - Mode `ssh --relay <host>` is reserved for Task 4.

- [ ] **Step 1: Write failing tests** in `tests/ssh.sh`. A fake `ssh` placed in a temp dir ahead of the shim's directory on PATH records `"$@"` (one arg per line) and exits with `$FAKE_SSH_STATUS`. Each case runs the wrapper with a live fake listener (`serve.pid` = `$$`) and asserts the fake received exactly the original args (pass-through):
  - `ssh host` (no command); `ssh -N -L 1:a:2 host`; `ssh -O check host`; `ssh -s host sftp`; `ssh -f host cmd`;
  - `ssh git@github.com git-upload-pack 'a/b.git'`; `ssh h scp -t /x`; `ssh h rsync --server -e.L . /x`;
  - `CC_ASKPASS_EXCLUDE='*.internal'` with `ssh db.internal sudo true`;
  - no listener (`serve.pid` dead) with `ssh h sudo true`;
  - exit status: `FAKE_SSH_STATUS=7 ssh h` → wrapper exits 7; stdout of the wrapper equals the fake's stdout byte-exact.
  - `find_real_ssh` loop: PATH containing only the shim dir → exit 255 and the message on stderr.
  - Parsing cases (call `parse_args` by sourcing the wrapper with `CC_ASKPASS_SHIM_LIB=1`, which makes it define functions and return): `-tp22 h cmd` → host `h`, command `cmd`, tty_opts `-t`; `-o ControlPath=/c -p 2 h a b` → caller_ctl `/c`, command `a b`; `-- h cmd`; `ssh://u@h:2 cmd` → host `ssh://u@h:2`; `-S /c h x` → caller_ctl `/c`.
- [ ] **Step 2: Run** `sh tests/ssh.sh` — Expected: FAIL (no wrapper).
- [ ] **Step 3: Implement** `bin/shim/ssh` with `getopts` and the option string from Global Constraints (POSIX `getopts` handles `-tp22`); pass-through is `exec "$real_ssh" "$@"` with the untouched original arguments. The wrap path for now also passes through (Task 4 replaces it).
- [ ] **Step 4: Run** `sh -n bin/shim/ssh && sh tests/ssh.sh` — Expected: `PASS: all ssh wrapper tests`.
- [ ] **Step 5: Commit** — `feat: ssh wrapper parses arguments and passes through what it must not touch`

---

### Task 4: Wrapping — master, probe, bootstrap, relay, reply (`bin/shim/ssh`, `bin/remote.sh`)

**Files:**
- Create: `bin/remote.sh`
- Modify: `bin/shim/ssh`
- Test: `tests/ssh.sh` (end-to-end section)

**Interfaces:**
- Consumes: Task 2 askpass (fields, relay listener), Task 3 functions.
- Produces:
  - Relay mode `bin/shim/ssh --relay <host>`: reads request lines on stdin (from the relay session), and for each runs `"$SSH_ASKPASS" "<prompt>"` with `CC_ASKPASS_VIA` (`<via>` of the line, or empty) and `CC_ASKPASS_REPORTED`, then sends the answer with `printf '%s\n' "$answer" | "$real_ssh" -S "$ctl" "$host" "<reply command for pid>"`. Its own args are exactly `--relay <host>` so `relayHost` (Task 1) can read them.
  - `bin/remote.sh`: sourced on the remote by the bootstrap, with `CCAP_TOKEN`, `CCAP_ASKPASS_B64`, `CCAP_SSH_B64`, `CCAP_CMD_B64` in the environment; also has a `relay` entry point (`sh -c "$(…remote.sh…)" relay <token>`) that waits up to 10 s for the token directory, writes `relay.pid`, and copies the request FIFO to stdout.

- [ ] **Step 1: Prerequisite and test harness.** Confirm `command -v sshd` (else stop: the human installs `openssh-server`). In `tests/ssh.sh` add `start_sshd`: a temp dir with a fresh ed25519 host key, `authorized_keys` holding a fresh test client key, an `sshd_config` (`Port` free high port, `ListenAddress 127.0.0.1`, `HostKey`, `AuthorizedKeysFile`, `PidFile`, `StrictModes no`, `UsePAM no`), started as the user with `-f config -E log`; and a client `ssh_config` (`Port`, `IdentityFile`, `StrictHostKeyChecking no`, `UserKnownHostsFile /dev/null`, `LogLevel ERROR`) passed via `-F` — so the wrapper is called as `ssh -F "$cfg" localhost …`.
- [ ] **Step 2: Write failing end-to-end tests** (each starts a local fake listener: a `bin/askpass --serve` reading requests and answering every request with `test-pw`, the way the mod would, writing the request lines it saw to a file):
  - `asks through the relay`: `ssh -F cfg localhost 'printf %s "$($SUDO_ASKPASS "Password: ")"'` prints `test-pw`; the listener saw one line whose parent args are `<shim> --relay localhost`, prompt `Password: `, reported field non-empty.
  - `sudo wrapper adds -A`: a fake `sudo` (records args) first on the remote PATH *after* the token dir; `ssh … 'sudo true; sudo -S true; sudo -n true'` → recorded `-A true`, `-S true`, `-n true`.
  - `wrapped command keeps quoting`: `ssh … 'echo "a  b" | grep -c "a  b"'` prints `1`; `ssh … echo '$HOME'` prints the remote home.
  - `fish login shell`: sshd hands the bootstrap line to the login shell, so the test feeds the exact line to fish: `fish -c "$(bootstrap_line 'echo ok')"` prints `ok` (`bootstrap_line` is the wrapper function that builds the remote command, reachable with `CC_ASKPASS_SHIM_LIB=1`); `SKIP` when `fish` is not installed. The same line through `sh -c`, `bash -c` and `zsh -c` (when installed) prints `ok` too.
  - `reuses a caller's master`: start a master with `ssh -F cfg -M -S "$t/caller.ctl" -o ControlPersist=yes -N -f localhost`; `ssh -F cfg -S "$t/caller.ctl" localhost 'printf %s "$($SUDO_ASKPASS P)"'` prints `test-pw`; afterwards `ssh -S "$t/caller.ctl" -O check localhost` still succeeds (the wrapper did not close it).
  - `stdout is untouched`: 256 random bytes through `ssh … cat` come back identical (`cmp`).
  - `exit status and stdin pass through`: `printf x | ssh … 'cat; exit 7'` prints `x`, exits 7.
  - `second hop`: `ssh … 'ssh -F "$cfg" localhost "printf %s \"\$(\$SUDO_ASKPASS P)\""'` prints `test-pw`; the listener's line has `via` = `localhost`.
  - `probe failure runs unwrapped`: a second sshd with `ForceCommand /bin/echo forced`; `ssh … sudo true` prints `forced`, no request reaches the listener, no `--relay` process remains.
  - `ssh -tt still asks`: `ssh -tt … 'sudo true'` with the fake sudo recording `-A`.
  - `killed wrapper cleans up`: start `ssh … 'sleep 30'`, kill the wrapper with TERM after 2 s; within 5 s no `--relay`/master process remains locally and no `cc-askpass-*` directory remains under the remote bases.
  - `no usable base directory`: `remote.sh` reads `CCAP_TEST_BASES` (space-separated, test-only) in place of its three bases; with `CCAP_TEST_BASES=/nonexistent` passed through the wrapper's `env` prefix, `ssh … 'echo ran; echo "${SUDO_ASKPASS:-unset}"'` prints `ran` and `unset`.
- [ ] **Step 3: Run** `sh tests/ssh.sh` — Expected: the end-to-end tests FAIL.
- [ ] **Step 4: Implement `bin/remote.sh`** per spec §4.4: base choice (writable and exec-allowed: test by writing and running a one-line script), stale sibling cleanup (`owner.pid` dead), files `askpass` (`CCAP_ASKPASS_B64` decoded), `ssh` (`CCAP_SSH_B64`), `sudo` wrapper (adds `-A` unless `-A`/`-S`/`-n`/`--askpass`/`--stdin`/`--non-interactive`), request FIFO `req`; exports per spec plus `CC_ASKPASS_REMOTE=1`; runs `"${SHELL:-/bin/sh}" -c "$cmd"` (cmd from `CCAP_CMD_B64`), trap removes the directory, exits with the command's status. base64 decode: `base64 -d` falling back to `base64 -D`.
- [ ] **Step 5: Implement the wrap path in `bin/shim/ssh`**:
  1. `ctl`: reuse `caller_ctl` if `"$real_ssh" -S "$caller_ctl" -O check "$host"` succeeds (then never `-O exit` it); else `$CC_ASKPASS_DIR/s.$$` (or `mktemp -d /tmp/ccap.XXXXXX`/`c` when that path exceeds 100 bytes) and start `"$real_ssh" $opts -M -S "$ctl" -o ControlPersist=yes -N -f "$host"`.
  2. Probe: `"$real_ssh" -S "$ctl" "$host" '<probe>' </dev/null` under a 5 s watchdog (background `sleep 5; kill`), compare stdout with `cc-askpass-probe-ok`.
  3. On probe failure: `"$real_ssh" -S "$ctl" $tty_opts "$host" "$command"`, keep its status.
  4. On success: start the relay `"$real_ssh" -S "$ctl" "$host" "<relay entry>" </dev/null | "$0" --relay "$host" &`; run `"$real_ssh" -S "$ctl" $tty_opts "$host" "$(bootstrap_line "$command")"`; keep its status. `bootstrap_line <command>` prints `env CCAP_TOKEN=<token> CCAP_RS_B64=<remote.sh> CCAP_ASKPASS_B64=<askpass> CCAP_SSH_B64=<this wrapper> CCAP_CMD_B64=<command> /bin/sh -c 'eval "$(printf %s "$CCAP_RS_B64" | base64 -d 2>/dev/null || printf %s "$CCAP_RS_B64" | base64 -D)"'` — every value base64 without newlines (`base64 | tr -d '\n'`), so the line holds only `[A-Za-z0-9+/=_ -]`, single quotes and the fixed `eval` text, which sh, bash, zsh and fish all parse the same way.
  5. Cleanup (also from a TERM/INT/HUP trap): kill the relay pipeline, `-O exit` our own master, remove our ctl directory; exit with the kept status.
  Token: 16 hex chars from `od -An -N8 -tx1 /dev/urandom | tr -d ' \n'`.
- [ ] **Step 6: Run** `sh -n bin/shim/ssh && sh -n bin/remote.sh && sh tests/ssh.sh && sh tests/askpass.sh` — Expected: all PASS (fish case PASS or SKIP).
- [ ] **Step 7: Commit** — `feat: wrap ssh commands so remote prompts reach the pane`

---

### Task 5: Mod wiring (`hooks/register.tsx`, `plugin.json`)

**Files:**
- Modify: `hooks/register.tsx`, `hooks/testkit.ts`, `.claude-plugin/plugin.json`
- Test: `hooks/pane.test.ts`, `hooks/lifecycle.test.ts`

**Interfaces:**
- Consumes: `parseRequest`, `relayHost`, `remoteLabel` (Task 1); wrapper relay mode args (Task 4).
- Produces: options `remoteHosts: boolean` (default `true`), `excludeHosts: readonly string[]` (default `[]`) read in `register(on, options)`.

- [ ] **Step 1: Spike (gate).** Add to `plugin.json`:
  ```json
  "userConfig": {
    "remoteHosts": { "type": "boolean", "title": "Remote prompts over ssh", "description": "Answer password prompts from hosts Claude reaches with ssh", "default": true },
    "excludeHosts": { "type": "string", "multiple": true, "title": "Hosts to leave alone", "description": "Glob patterns of ssh hosts whose commands are never wrapped", "default": [] }
  }
  ```
  Run `claude plugin validate .`. Expected: passes and lists both fields. If the schema is refused, read the error, adjust to the shape it names, and record the working shape in the ledger.
- [ ] **Step 2: Write failing tests:**
  - `lifecycle.test.ts`: `prefixes Bash commands with the shim directory while listening` — after ready, `$.tool.call({ tool: 'Bash', command: 'ssh h sudo true' })` reaches the test's own `tool.call` hook with `command` === `` `export PATH='${root}/bin/shim':"$PATH"; ssh h sudo true` ``; before ready, unchanged; with `test(name, { options: { remoteHosts: false } }, …)`, unchanged. `sets CC_ASKPASS_EXCLUDE from excludeHosts` (`['*.internal','git.example.com']` → `"*.internal\ngit.example.com"`). `the sudo note mentions ssh` — note text contains `ssh host sudo`.
  - `pane.test.ts`: `accepts a request relayed by the ssh wrapper` — helper parent args `/bin/sh <root>/bin/shim/ssh --relay server`, line `4242\t[sudo] password for bob: \t\tsudo apt update` → pane opens; heading text `sudo on server needs your password`; `$` line `$ sudo apt update (reported by server)`; prompt line shows `[sudo] password for bob`; a `remote` tag text is present. `labels a second hop` — via `db01` → heading contains `on db01 via server`. `rejects a relay with a forged wrapper path` — parent `/bin/sh /tmp/x/bin/shim/ssh --relay server` → toast `Rejected askpass request`, empty reply. `Claude ran matching ignores the PATH prefix` — Bash command recorded and matched without the prefix. Extend `password never leaks` to a relayed request.
- [ ] **Step 3: Run** `claude plugin test .` — Expected: new tests FAIL.
- [ ] **Step 4: Implement:**
  - `tool.call` (Bash): record `e.command` (unprefixed) as today; when `isListening && options.remoteHosts !== false`, return `next({ ...e, command: prefix + e.command })` with the root single-quoted (`'` → `'\''`).
  - `setEnv`: `CC_ASKPASS_EXCLUDE` from `excludeHosts`; `unsetEnv` clears it.
  - `verify`: when the parent is neither sudo nor a trusted client, try `relayHost(parentArgs, `${root}/bin/shim/ssh`)` on the parent's `args` (the `ps -o args=` already fetched); a host makes a `Requester` with `remote: { host, via, reported }` (extend the type with an optional `remote` field); skip the exe check for it.
  - Pane: for remote requesters use heading `${comm} on ${remoteLabel(host, via)} needs a password` where `comm` is `sudo` when `reported` starts with `sudo` else the first word of `reported`, or `a program`; a dim `remote` tag line; `$` line `$ ${reported} (reported by ${host})` (or `$ (not reported by ${host})`); masking per `shouldMask(false, prompt)` except `reported` starting with `sudo` → masked; retry detection keyed by `${host}:${pid}`.
  - `SUDO_NOTE`: add the sentence from spec §5.4.
- [ ] **Step 5: Run** `claude plugin validate . && claude plugin test . && npx -y -p typescript@5 tsc -p .` — Expected: all pass, tsc clean.
- [ ] **Step 6: Commit** — `feat: answer prompts relayed from remote hosts`

---

### Task 6: CI, docs, and manual end-to-end

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `docs/superpowers/specs/2026-10-07-remote-sudo-over-ssh-design.md` (status line)

- [ ] **Step 1: CI.** Linux job: `sudo apt-get install -y openssh-server` before `sh tests/ssh.sh`. macOS job: `sshd` is present (`/usr/sbin/sshd`); the test starts its own, so no Remote Login setting is needed. Push to a branch and confirm both jobs pass (spec §10 spike 3); if the macOS runner refuses the user sshd, record the error and make the end-to-end section print `SKIP: no usable sshd` there, keeping the unit section.
- [ ] **Step 2: README (all three languages)**: a "Remote hosts" section under Usage — what works (`ssh host sudo …`, sudo inside remote scripts, further hops, rsync/ansible), that hosts which cannot take part are left untouched automatically, the `(reported by host)` label, the two options and how to set them (`/config` or `pluginConfigs`); under Security, the trust boundary from spec §8 and "type the remote host's password, never a local one, into a pane that names another host"; under Limitations, Windows sshd and `/usr/bin/sudo` called with `-t` by absolute path.
- [ ] **Step 3: Manual E2E** (the human types real passwords): in the macOS VM and in WSL with `claude --plugin-dir .`, ask Claude to run `ssh <host> sudo -k true`, `ssh <host> 'sudo -k; ./script-that-calls-sudo.sh'`, `ssh -J <host> <host2> sudo -k true` where available, and `git ls-remote git@github.com:<any public repo>` (must work unchanged). Check spec §10 spike 1 at the same time: the transcript shows Claude's original command, and a `run_in_background` command gets the prefix (its remote sudo asks).
- [ ] **Step 4: Spec status** → `implemented (2026-10-xx)`.
- [ ] **Step 5: Commit** — `docs: remote hosts in the READMEs; CI runs the ssh tests`
