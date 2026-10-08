# cc-askpass

English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

**Let Claude run commands that need sudo, instead of copying them into your own terminal.**

When a command Claude runs needs a password (`sudo apt install`, an install script that calls sudo, `git push` over HTTPS, an ssh key with a passphrase), cc-askpass opens a password pane inside Claude Code. You type the password there, and it goes straight to the program that asked. It never reaches the model, the transcript or any log.

Without it, Claude's Bash tool has no terminal, so sudo fails at once:

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

So you end up copying the command into your own terminal, running it there and telling Claude how it went. The other ways around it are riskier: pasting the password into the chat for `sudo -S` puts it in the model's context, and `NOPASSWD` in sudoers lets anything run as root without asking.

- **Nothing to configure.** Install it, and sudo, ssh and git simply ask.
- **The password stays out of the model.** It travels from the pane to the asking process through a private FIFO, never through the model's context, logs, the command line or a file.
- **You see what you are approving.** The pane shows the exact command that will run as root, and the command Claude ran to get there.
- **You see who asks.** Every request is shown, none is silently rejected. The pane names the program that asked (`Asked by:`) and the command Claude ran (`Claude ran:`), and you decide.

## Requirements

- Claude Code 2.1.289 or later
- Linux, WSL, macOS (tested on macOS 14 and 26) or Windows. On Windows, Git for Windows is optional: without it Claude Code uses the PowerShell tool only. The mod covers both tools. See [Windows](#windows).

## Install

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

Then restart Claude Code or run `/reload-plugins`. There is nothing to configure.

## Usage

Ask Claude to run anything that needs sudo. A **sudo password** pane opens and shows the whole command that will run as root (for example `$ sudo apt update`). When sudo was called from something else Claude ran, such as `./install.sh` or `curl … | bash`, a `Claude ran:` line shows that command too. Under the heading, an `Asked by:` line names the program that asked. Answer only when `Asked by:` and `Claude ran:` are what you expect. Type the password and press Enter.

- **Show/Hide** reveals what you typed. Input is masked for sudo, and for every other prompt except git's `Username for '...'` and ssh's `(yes/no)` host-key question.
- **Cancel** or Esc answers nothing; sudo stops with "no password was provided".
- A wrong password asks again with "Sorry, try again".
- If you were typing in the prompt (or a dialog was open) when the pane appeared, the pane cannot take the keyboard. It then says in red: click it (or press ctrl+x tab; outside fullscreen mode only the keys work) before typing, so your password does not end up in the prompt and get sent to Claude.
- Claude Code decides where the pane goes: beside the transcript in fullscreen mode at 110 columns or more, otherwise above the prompt.
- If the terminal is narrower than 144 columns the pane may not open on its own. A line above the prompt then says `sudo is waiting for a password — click the button below or type /askpass`, with an **Open password prompt** button under it. Click the button or type `/askpass`; both work while Claude is busy. Outside fullscreen mode the terminal reports no clicks, so the line says to press ctrl+x tab (which puts the keyboard on the button) then Enter, or type `/askpass`.

### Remote hosts

Password prompts on other hosts reached with ssh get the same pane:

- `ssh host sudo apt update`, and sudo inside a remote script (`ssh host ./deploy.sh`).
- Further hops: `ssh` run from the remote host to a third one.
- rsync, ansible and scripts that call ssh. A remote sudo given `-S` or `-n` (as ansible's become does) is left alone, so it does not reach the pane.

Hosts that cannot take part are detected and left untouched automatically, so ssh behaves as it would without cc-askpass: git hosting (`git@github.com`), network devices, accounts with a forced command, Windows sshd, and hosts without `/bin/sh`.

The pane names the host (`sudo on server needs your password`), labels the `$` line `(reported by server)`, and for remote prompts always shows the `Claude ran:` line plus a warning to check it before you answer.

A caller's own `ControlPath` or `-S` is not reused, so tools such as ansible open one extra connection. Nor is a `ControlMaster`/`ControlPersist` in your own `~/.ssh/config`: every ssh command cc-askpass handles opens its own connection, so a host with password or two-factor login asks for it on every command; add such hosts to `excludeHosts`. Each such command also starts a few extra login shells on the host (the check, the relay, one per answer).

Two options, set in `/config` or in settings:

- `remoteHosts` (default on): answer prompts from remote hosts. Turn it off with `"pluginConfigs": { "cc-askpass": { "options": { "remoteHosts": false } } }`.
- `excludeHosts`: glob patterns matched against the host name; ssh to a matching host is never wrapped.

## Ask once instead of every time

Every Bash command Claude runs is a new process, so sudo asks for the password every time. cc-askpass does not cache passwords: a cached password could be read by any process running as you. To have sudo remember that you authenticated instead, run `sudo visudo -f /etc/sudoers.d/cc-askpass` and add:

```
Defaults:YOUR_USER timestamp_type=global
```

sudo then shares one timestamp across all your terminals and Claude Code sessions for its usual timeout (15 minutes by default), and cc-askpass asks once per timeout.

## How it works

```
Claude's Bash command → sudo → bin/askpass → request FIFO → cc-askpass mod → pane
                                     ↑                                          │
                                     └──────────── reply FIFO ←─────────────────┘
```

When a session starts, the mod starts a small listener (`bin/askpass --serve`) and sets these variables for the commands Claude runs: `SUDO_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`, `CC_ASKPASS_DIR`, and `DISPLAY=:0` if `DISPLAY` was unset (sudo only uses askpass when `DISPLAY` is set; `CC_ASKPASS_SET_DISPLAY=1` marks that the mod set it). sudo then runs `bin/askpass`, which hands the prompt to the mod through a FIFO in `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/` (mode 0700). The mod looks up with `ps` which program started the helper, shows the pane with that program in the `Asked by:` line, and writes your answer into that helper's own FIFO. While the listener runs, the mod also adds a short note to Claude's system prompt saying sudo can ask for a password, so Claude runs `sudo` instead of `sudo -n` or asking you to run it yourself.

For ssh, the mod also puts a small `ssh` wrapper first on the PATH of the commands Claude runs. It starts the real ssh with a private connection to the host, checks that the host can take part, and sets up a relay so that a prompt raised there (sudo on the remote host, or a further ssh hop) comes back through the same FIFO to the pane. Hosts that fail the check run exactly as without it.

## Windows

On Windows the mod has no shell helpers. On the first session start, and again after a plugin update, it builds its helper from the C# source in `win/` with the .NET Framework that ships with Windows 10 and 11. Nothing binary is downloaded or shipped. The build goes to `win/out/` and takes a moment; later starts reuse it.

- The helper is one `.exe` that the mod starts as the listener. ssh and git run it as their askpass program, and it talks to the mod over a named pipe that only your user can open.
- Both tools are covered: Git for Windows' ssh in the Bash tool, and Windows OpenSSH in the PowerShell tool. ssh key passphrases, ssh password logins, git over HTTPS or ssh, and sudo on remote hosts all ask in the pane. There is no local sudo on Windows, so nothing is done for `sudo.exe` or UAC.
- Machines that block `Add-Type` or unsigned programs (AppLocker, WDAC, an enforced execution policy) keep the mod off. A toast says why, and Claude's commands behave as without the mod.
- Remote hosts: Windows' ssh cannot share connections, so a wrapped `ssh host …` opens two connections, one for the prompts and one for the command. A password login is asked twice per command; key or agent logins notice nothing.

## Security

- The password is never written to the model's context, logs, toasts, the status line, command-line arguments, or files.
- Every request is shown and none is rejected because of who sent it. You decide from two lines: `Asked by:` is the program that asked (the operating system's answer where it has one), and `Claude ran:` is the command Claude ran. Answer only when both are what you expect, for example sudo or ssh for a command you recognise. An `ssh` or `git` command sends your answer to the server it names.
- Any program running as you can raise the pane, including scripts Claude runs, and can capture what you type if you answer it. cc-askpass keeps the password out of the model's context in normal use; it is not a sandbox against hostile code running as you.
- On Linux and macOS, `Asked by:` rests on the pid the helper reports. A program that waits for a real sudo prompt and races it could be shown as that sudo. On Windows the kernel reports the pid.
- A request that did not come through cc-askpass's helper is marked as unverified in the pane.
- Remote prompts name the host. Type the remote host's password (never a local one) into a pane that names another host. Set `remoteHosts` to `false` to turn the feature off.

## Limitations

- `su` and `doas` cannot use askpass. Use sudo.
- polkit (`pkexec`, `run0`, `systemctl` as a normal user) fails with "Interactive authentication required" instead of asking.
- Yes/no prompts are not handled. Use flags such as `-y` or `--no-interaction`.
- Masked input tracks typing anywhere in the field, but a character deleted in the middle counts as deleted at the end. If you edit in the middle, press Show to check, or clear the field and type again.
- On hosts without a display, the `DISPLAY=:0` placeholder may make a few graphical programs (for example `xdg-open`) try to reach an X server and fail.
- The mobile app (and Remote Control from a phone) cannot show an input field; answer from the terminal or the desktop app.
- In non-interactive runs (`claude -p`, the SDK) the mod does nothing, since nobody could answer; sudo fails as it would without it.
- With the Bash sandbox on, sudo cannot raise privileges and the helper cannot see the listener, so it fails at once with "the cc-askpass listener is not running".
- ssh confirmation prompts (`SSH_ASKPASS_PROMPT=confirm`) appear as a plain text prompt.
- A Windows sshd as the remote host is left untouched (no remote prompts).
- Windows: `sudo.exe` and UAC prompts are not handled, and programs that show their own window (Git Credential Manager, Pageant) keep doing so.
- `/usr/bin/sudo` called by absolute path under `ssh -t` reads the terminal instead of asking.
- A login rc file on the remote host that prints to stdout makes the check fail, and the command runs without remote prompts.
- An ssh option value or host with a space in it (`-o "User alice"`) means no remote prompts for that command; write `-o User=alice` instead.
- Claude's Bash commands run with `…/bin/shim` first on PATH (set when the session starts, so commands are not changed). It holds only the ssh wrapper, which steps aside when `remoteHosts` is off.

## Uninstall

```sh
claude plugin uninstall cc-askpass
```

If you added the sudoers file, remove it with `sudo rm /etc/sudoers.d/cc-askpass`.

## Development

```sh
sh tests/askpass.sh                            # helper tests (Linux, WSL, macOS)
sh tests/ssh.sh                                # ssh wrapper tests (Linux, WSL, macOS)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1   # Windows tests
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # run Claude Code with this checkout
npx -p typescript tsc -p .                     # type-check (after one --plugin-dir run)
```

## License

[MIT](LICENSE)
