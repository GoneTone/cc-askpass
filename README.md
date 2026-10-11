# cc-askpass

English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

**A Claude Code mod that lets Claude run commands that need sudo, instead of copying them into your own terminal.**

When a command Claude runs asks for a password (`sudo apt install`, an install script that calls sudo, `git push` over HTTPS, an ssh key passphrase), cc-askpass opens a password pane inside Claude Code where you can type it. The password goes straight to the program that asked. It never reaches the model, the transcript or any log.

Without it, Claude's Bash tool has no terminal, so sudo fails at once:

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

So you end up running the command in your own terminal. Pasting the password into the chat or adding `NOPASSWD` to sudoers also gets around it, but both are riskier.

- **Nothing to configure.** Install it, and sudo, ssh and git ask for passwords in the pane.
- **The password stays out of the model.** It never appears in the model's context, in logs, on a command line or in a file.
- **You see what you approve.** The pane shows the command that will run as root, the program that asked, and the command Claude ran.

## Install

Needs Claude Code 2.1.286 or later, on Linux, WSL, macOS or Windows. Run these in Claude Code:

```
/plugin marketplace add GoneTone/cc-askpass
/plugin install cc-askpass@cc-askpass
```

`/plugin install` asks where to install it and shows its options; the defaults are fine. Then restart Claude Code or run `/reload-plugins`.

## Usage

When a command Claude runs asks for a password, the pane opens. Its `$` line shows the command that asked; for sudo, that is the command that will run as root (for example `$ sudo apt update`). `Asked by:` names the program that asked. If the prompt came from something else Claude ran (such as `./install.sh`), `Claude ran:` shows that command. Answer only if these are what you expect: type the password and press Enter.

- **Show/Hide** shows or hides what you typed.
- **Cancel** or Esc sends no answer, so sudo stops.
- If the password is wrong, sudo asks again.

<details>
<summary><b>The pane does not open, or does not take your typing</b></summary>

- If you were typing in the prompt (or a dialog was open) when the pane appeared, your keys still go to the prompt. The pane then shows a red note: move the keyboard to the pane before typing, so your password does not end up in the prompt and get sent to Claude. To do that, click the pane or press ctrl+x tab (outside fullscreen mode clicking does not work, so use the keys).
- In a terminal narrower than 144 columns the pane may not open on its own. A line above the prompt then says, for example, `sudo is waiting for a password`, with an **Open password prompt** button. Click the button or type `/askpass`; both work while Claude is busy. Outside fullscreen mode, press ctrl+x tab then Enter instead of clicking.
- What you type is hidden, except for git's `Username for '...'` and ssh's `(yes/no)` host-key question.

</details>

<details>
<summary><b>Remote hosts (ssh)</b></summary>

Password prompts on hosts reached with ssh use the same pane: `ssh host sudo apt update`, sudo inside a remote script (`ssh host ./deploy.sh`), ssh from that host on to another one, and rsync, ansible or scripts that call ssh. A remote sudo run with `-S` (password from standard input) or `-n` (never ask), as ansible's become does, does not use the pane.

The pane names the host (`sudo on server needs your password`) and marks the `$` line `(reported by server)`, since that command comes from the remote host and cannot be checked locally. It always shows `Claude ran:`, with a warning to check it. Type that host's password, never a local one.

Some hosts cannot send prompts back: network devices, accounts with a forced command, Windows sshd, and hosts without `/bin/sh`. cc-askpass detects them, and the command still runs, but prompts on those hosts do not reach the pane. git over ssh (`git push` to `git@github.com`) is left alone entirely.

Every ssh command cc-askpass handles opens a new connection of its own. It does not reuse a shared connection set up with `ControlMaster`/`ControlPersist` in your `~/.ssh/config`, nor a caller's own `ControlPath` or `-S` (so tools such as ansible open an extra connection for each command). If logging in to a host takes a password or a two-factor code, you are therefore asked for it on every command. To avoid that, add the host to `excludeHosts`: ssh to it then runs with your original arguments, so your own shared connection works again, but sudo prompts on that host no longer reach the pane. Each handled command also starts a few extra login shells on the host.

Two options control this. Set them with `/plugin configure cc-askpass@cc-askpass` in Claude Code, or in your settings:

- `remoteHosts` (default on): show password prompts from remote hosts in the pane. Turn it off with `"pluginConfigs": { "cc-askpass@cc-askpass": { "options": { "remoteHosts": false } } }`.
- `excludeHosts`: glob patterns matched against the host name. cc-askpass leaves ssh to a matching host alone.

</details>

<details>
<summary><b>Ask once instead of every time</b></summary>

Every command Claude runs is a new process, so sudo asks every time. cc-askpass does not cache passwords, since any program running as you could read the cache. Instead, you can have sudo remember that you already entered it: run `sudo visudo -f /etc/sudoers.d/cc-askpass` and add:

```
Defaults:YOUR_USER timestamp_type=global, timestamp_timeout=5
```

sudo then shares one timestamp across all your terminals and Claude Code sessions, and asks again only after 5 minutes.

**This weakens what cc-askpass protects.** Until the timestamp expires:

- Claude can run sudo without the pane appearing, so you no longer see or approve each command that runs as root.
- Any other program running as you, in any terminal, can also run sudo without a password.

Turn it on only if you accept that. Keep the timeout short, and run `sudo -k` when you are done to end it at once. Without `timestamp_timeout`, sudo uses its default: 5 minutes, or 15 on some distributions (Ubuntu, for example).

</details>

<details>
<summary><b>Windows</b></summary>

- Git for Windows is optional: without it Claude Code uses the PowerShell tool only. Both tools are covered: Git for Windows' ssh in the Bash tool, and Windows OpenSSH in the PowerShell tool.
- ssh key passphrases, ssh password logins, git over HTTPS or ssh, and sudo on remote hosts use the pane. Windows' own `sudo.exe` and UAC prompts are not handled; they show their own Windows dialog.
- On the first session start, and after a plugin update, cc-askpass builds its helper program from the C# source in `win/` with the .NET Framework built into Windows 10 and 11. Nothing binary is downloaded or shipped. The build goes to `win/out/` and takes a moment.
- On machines that block `Add-Type` or unsigned programs (AppLocker, WDAC, an enforced execution policy), cc-askpass stays off, and a toast says why.
- Remote hosts: Windows' ssh cannot share connections, so `ssh host …` opens two connections, one for the prompts and one for the command. A password login, or a key with a passphrase and no agent, is therefore asked twice per command; agent logins and keys without a passphrase notice nothing.

</details>

<details>
<summary><b>Security</b></summary>

- The password is never written to the model's context, logs, toasts, the status line, command-line arguments, or files.
- Any program running as you can open the pane, including scripts Claude runs, and gets what you type if you answer it. cc-askpass keeps the password away from the model in normal use, but it is not a sandbox and cannot stop hostile code running as you.
- `Asked by:` comes from the operating system where possible. On Linux and macOS it relies on the process ID that cc-askpass's helper reports, so a program that sends its request just as a real sudo prompt appears could be shown as that sudo. On Windows the kernel reports the process ID.
- A request that did not come through cc-askpass's helper is marked as unverified.
- When you answer an `ssh` or `git` prompt, the password goes to the server named in that command.

</details>

<details>
<summary><b>Limitations</b></summary>

- `su` and `doas` cannot use askpass. Use sudo.
- polkit (`pkexec`, `run0`, `systemctl` as a normal user) fails with "Interactive authentication required" instead of asking.
- Yes/no questions that a program asks by itself (such as apt's `Do you want to continue? [Y/n]`) are not handled. Use flags such as `-y` or `--no-interaction`.
- In hidden input, deleting a character in the middle removes the last character instead. If you edit in the middle, press Show to check, or clear the field and type again.
- On hosts without a display, the placeholder `DISPLAY=:0` that cc-askpass sets may make a few graphical programs (such as `xdg-open`) fail.
- The mobile app (and Remote Control from a phone) cannot show an input field; answer from the terminal or the desktop app.
- In non-interactive runs (`claude -p`, the SDK) cc-askpass does nothing, since nobody is there to answer; sudo fails as it would without it.
- With the Bash sandbox on, sudo fails at once with "the cc-askpass listener is not running".
- ssh confirmation prompts (`SSH_ASKPASS_PROMPT=confirm`) appear as an ordinary text prompt.
- Windows: programs that show their own password window (Git Credential Manager, Pageant) keep doing so.
- On a remote host, sudo called by its full path (such as `/usr/bin/sudo`) does not use the pane: it fails for lack of a terminal, or reads the terminal under `ssh -t`. Call it as plain `sudo`.
- If a shell startup file on the remote host (such as `.bashrc` or `.zshenv`) prints text when a command runs, a welcome message for example, cc-askpass cannot confirm that the host supports it. The command still runs, but sudo there does not reach the pane. To fix it, print that text only in interactive shells, or send it to stderr.
- If an ssh option before the host name, or the host name itself, contains a space, such as `-o "User alice"` or `-i "/keys/my key"`, cc-askpass leaves that ssh command alone, so sudo on the remote host does not reach the pane. For `-o`, drop the space: `-o User=alice`.

</details>

<details>
<summary><b>How it works</b></summary>

cc-askpass has two parts: a mod inside Claude Code that draws the pane, and a small helper program (`bin/askpass`) that sudo and ssh run to ask for a password.

```
Claude's Bash command → sudo → bin/askpass → request FIFO → cc-askpass mod → pane
                                     ↑                                          │
                                     └──────────── reply FIFO ←─────────────────┘
```

When a session starts, the mod starts a listener (`bin/askpass --serve`) and sets `SUDO_ASKPASS` and `SSH_ASKPASS` for the commands Claude runs (plus `DISPLAY=:0` if it was unset, since sudo only uses askpass when `DISPLAY` is set). sudo then runs `bin/askpass`, which hands the prompt to the mod through a FIFO in a private directory (mode 0700). The mod uses `ps` to find which program started the helper, shows the pane, and writes your answer into that helper's own FIFO. It also tells Claude in its system prompt that sudo can ask for a password, so Claude runs `sudo` instead of `sudo -n`.

For ssh, the mod puts a small `ssh` wrapper first on the PATH of the commands Claude runs. The wrapper checks that the host supports this and sets up a relay, so a prompt raised there (remote sudo, or ssh on to another host) comes back to the same pane. On hosts that fail the check, the command still runs, without remote prompts.

On Windows the helper is one `.exe` that talks to the mod over a named pipe only your user can open.

</details>

## Uninstall

Run these in Claude Code:

```
/plugin uninstall cc-askpass@cc-askpass
/plugin marketplace remove cc-askpass
```

The second line removes the marketplace that the install added. If you added the sudoers file, remove it with `sudo rm /etc/sudoers.d/cc-askpass`.

## Development

### Run your checkout

```sh
claude --plugin-dir .
```

This starts Claude Code with the plugin loaded from this directory. After you change a file, run `/reload-plugins` or restart Claude Code. On Windows the helper is rebuilt by itself when `win/cc-askpass.cs` changes, since each build goes to `win/out/<hash of the source>`.

### Tests

```sh
claude plugin validate .
claude plugin test .
```

`validate` checks the plugin's files. `test` runs the mod's tests (`hooks/*.test.ts`) inside Claude Code's test kit; it needs no login and works on every platform.

```sh
sh tests/askpass.sh   # Linux, WSL, macOS
sh tests/ssh.sh       # Linux, WSL, macOS
```

`tests/askpass.sh` tests the helper. `tests/ssh.sh` tests the ssh wrapper; its end-to-end part starts its own sshd on 127.0.0.1 as your user, so it needs `sshd` installed (`openssh-server` on Debian and Ubuntu). Without it those tests are skipped with a warning. It also checks that every shell it finds (sh, bash, zsh, fish) reads the remote setup command the same way, and uses `python3` for a few socket checks when available.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1
```

Run it from the repository root on Windows. It compiles the helper and tests it.

### Type-check

```sh
npx -p typescript tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the mod, so run `claude --plugin-dir .` once before this. That directory is git-ignored.

### CI

GitHub Actions runs `validate` and `test` on Ubuntu, macOS and Windows, then `tests/askpass.sh` and `tests/ssh.sh` on Ubuntu and macOS, and `tests/win.ps1` on Windows. A failure on one platform does not stop the others.

### Conventions

- Files use LF line endings (see `.gitattributes`).
- Keep `tests/win.ps1` ASCII: Windows PowerShell reads a script without a BOM in the ANSI code page.

## License

[MIT](LICENSE)
