# cc-askpass

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文

Claude Code 的 Bash 工具执行命令时没有终端，所以命令需要 sudo 密码时，sudo 会直接放弃：

```
sudo: a terminal is required to read the password; either use the -S option ...
```

cc-askpass 是一个 Claude Code mod，会在 Claude Code 里弹出密码面板来响应这些提示。密码直接交给 sudo，不会进入模型的 context。

覆盖范围：sudo（包括脚本和安装程序里调用的 sudo）、ssh 密钥口令，以及通过 HTTPS 的 git 账号密码。

## 要求

- Claude Code 2.1.289 及以上
- Linux 或 WSL。macOS 理论上可用，但未经测试。不支持 Windows 原生版。

## 安装

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

然后重启 Claude Code，或运行 `/reload-plugins`。无需任何配置。

## 使用方法

让 Claude 执行任何需要 sudo 的命令，就会弹出 **sudo password** 面板，并显示是哪个命令在请求密码（例如 `sudo apt update`）。输入密码后按 Enter。

- **Show/Hide** 可以显示你输入的内容。sudo 一律遮盖；其他提示也默认遮盖，只有 git 的 `Username for '...'` 和 ssh 首次连接的 `(yes/no)` 确认例外。
- **Cancel** 或 Esc 表示不回答，sudo 会显示“no password was provided”并退出。
- 密码输错时会再问一次，并提示“Sorry, try again”。
- 终端宽度不足 144 列时，面板可能不会自动弹出，此时状态栏会显示 `sudo is waiting for a password — type /askpass`。输入 `/askpass` 即可打开，Claude 运行中也能用。

## 一段时间内只问一次

Claude 执行的每个 Bash 命令都是新的进程，所以 sudo 每次都会再问密码。cc-askpass 不会缓存密码，因为以你的身份运行的任何程序都可能读到缓存的密码。如果想让 sudo 记住“已经验证过”，请运行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 并加入：

```
Defaults:你的用户名 timestamp_type=global
```

这样 sudo 会在所有终端和 Claude Code 会话之间共享同一个时间戳，有效期是 sudo 原本的超时时间（默认 15 分钟），cc-askpass 在这段时间内只会问一次。

## 工作原理

```
Claude 的 Bash 命令 → sudo → bin/askpass → 请求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回复 FIFO ←──────────────┘
```

会话开始时，mod 会启动一个小型监听程序（`bin/askpass --serve`），并为 Claude 执行的命令设置这些环境变量：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本未设置时补上 `DISPLAY=:0`（sudo 只有在设置了 `DISPLAY` 时才会使用 askpass）。sudo 接着运行 `bin/askpass`，它通过 `$XDG_RUNTIME_DIR/cc-askpass/<session>/`（权限 0700）里的 FIFO 把提示交给 mod。mod 用 `ps` 确认请求确实来自 `bin/askpass`，弹出面板，再把你的回答写进该 helper 专属的 FIFO。

## 安全性

- 密码不会写入模型的 context、日志、toast、状态栏、命令行参数或任何文件。
- 只接受由以 root 身份运行的 sudo，或属于 root 的 `ssh`、`ssh-add`、`scp`、`sftp`、`git` 可执行文件所启动的 `bin/askpass` 请求。其他来源一律拒绝，例如命令自己运行 `$SUDO_ASKPASS` 来读取你的回答。
- 面板会显示实际请求密码的命令，回答前请先确认：`ssh` 或 `git` 命令会把你的回答发送到它指定的服务器。
- 限制：以你自己的用户身份运行的恶意程序，有机会在真正的请求进行时抢先读走回复。cc-askpass 的目标是正常使用时不让密码进入模型的 context，它不是防范同一用户下恶意程序的沙箱。

## 限制

- `su` 和 `doas` 不支持 askpass，请改用 sudo。
- polkit（`pkexec`、`run0`、以普通用户运行 `systemctl`）会直接报错“Interactive authentication required”而不会询问。
- 不处理 y/n 之类的提问，请使用 `-y`、`--no-interaction` 等参数。
- 遮盖输入只跟踪在输入框末尾的输入和删除。如果移动了光标，请按 Show 确认，或清空后重新输入。
- 在没有图形界面的主机上，`DISPLAY=:0` 这个占位值可能让少数图形程序（例如 `xdg-open`）尝试连接 X server 而失败。
- 移动端 app 无法显示输入框，请改在终端或桌面版 app 回答。
- ssh 的确认提示（`SSH_ASKPASS_PROMPT=confirm`）会以普通文本输入的形式出现。
- 在 macOS 上，ssh 和 git 的提示会被拒绝，因为确认调用者是真正 ssh/git 可执行文件的检查需要 Linux 的 `/proc`。sudo 可以正常使用。

## 卸载

```sh
claude plugin uninstall cc-askpass
```

如果你添加了 sudoers 配置文件，请用 `sudo rm /etc/sudoers.d/cc-askpass` 删除。

## 开发

```sh
sh tests/askpass.sh                            # helper 测试（Linux/WSL）
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用这份源码启动 Claude Code
```

## 许可证

[MIT](LICENSE)
