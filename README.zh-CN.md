# cc-askpass

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文

**让 Claude 直接运行需要 sudo 的命令，不用再把命令复制到自己的终端执行。**

Claude 执行的命令需要密码时（`sudo apt install`、会调用 sudo 的安装脚本、通过 HTTPS 的 `git push`、带口令的 ssh 密钥），cc-askpass 会在 Claude Code 里弹出密码面板。你在面板里输入密码，密码会直接交给发起请求的程序，不会进入模型、对话记录或任何日志。

没有它的话，Claude 的 Bash 工具没有终端，sudo 会直接失败：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

结果只好把命令复制到自己的终端执行，再把结果告诉 Claude。其他变通方法风险更高：把密码粘贴到对话里让 Claude 用 `sudo -S`，密码就进了模型的 context；在 sudoers 里配置 `NOPASSWD`，则任何程序都能不经询问就以 root 运行。

- **无需配置。** 装好之后，sudo、ssh 和 git 需要密码时就会直接询问你。
- **密码不经过模型。** 密码从面板经由私有的 FIFO 送到发起请求的进程，不会出现在模型的 context、日志、命令行或任何文件里。
- **看得到你在批准什么。** 面板会显示将以 root 执行的完整命令，以及 Claude 为此执行了哪条命令。
- **只接受真实的请求。** 每个请求都必须来自 sudo 或真正的 ssh/git 可执行文件，其他一律拒绝。

## 要求

- Claude Code 2.1.289 及以上
- Linux、WSL 或 macOS（已在 macOS 14 和 26 测试）。不支持 Windows 原生版。

## 安装

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

然后重启 Claude Code，或运行 `/reload-plugins`。无需任何配置。

## 使用方法

让 Claude 执行任何需要 sudo 的命令，就会弹出 **sudo password** 面板，并完整显示将以 root 执行的命令（例如 `$ sudo apt update`）。如果 sudo 是由 Claude 执行的其他东西间接调用的，例如 `./install.sh` 或 `curl … | bash`，还会多一行 `Claude ran:` 显示那个命令。输入密码后按 Enter。

- **Show/Hide** 可以显示你输入的内容。sudo 一律遮盖；其他提示也默认遮盖，只有 git 的 `Username for '...'` 和 ssh 首次连接的 `(yes/no)` 确认例外。
- **Cancel** 或 Esc 表示不回答，sudo 会显示“no password was provided”并退出。
- 密码输错时会再问一次，并提示“Sorry, try again”。
- 如果面板出现时你正在输入框里打字（或有对话框打开），面板就拿不到键盘。这时它会用红字提示：先点一下面板（或按 ctrl+x tab；非全屏模式只能用按键）再输入，以免密码打进输入框、被当成消息发给 Claude。
- 面板出现在哪里由 Claude Code 决定：全屏模式且宽度 110 列及以上时停靠在对话记录旁边，其他情况出现在提示栏上方。
- 终端宽度不足 144 列时，面板可能不会自动弹出，此时提示栏上方会显示 `sudo is waiting for a password — click the button below or type /askpass`，下方有一个 **Open password prompt** 按钮。点击按钮或输入 `/askpass` 即可打开，Claude 运行中也能用。非全屏模式下终端不支持鼠标点击，这行提示会改为请你按 ctrl+x tab（键盘会移到按钮上）再按 Enter，或输入 `/askpass`。

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

会话开始时，mod 会启动一个小型监听程序（`bin/askpass --serve`），并为 Claude 执行的命令设置这些环境变量：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本未设置时补上 `DISPLAY=:0`（sudo 只有在设置了 `DISPLAY` 时才会使用 askpass；`CC_ASKPASS_SET_DISPLAY=1` 标记这是 mod 设置的）。sudo 接着运行 `bin/askpass`，它通过 `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/`（权限 0700）里的 FIFO 把提示交给 mod。mod 用 `ps` 确认请求确实来自 `bin/askpass`，弹出面板，再把你的回答写进该 helper 专属的 FIFO。监听程序运行期间，mod 还会在 Claude 的 system prompt 里加一段说明，告诉它 sudo 可以询问密码，所以 Claude 会直接执行 `sudo`，而不是改用 `sudo -n` 或让你自己执行。

## 安全性

- 密码不会写入模型的 context、日志、toast、状态栏、命令行参数或任何文件。
- 只接受由以 root 身份运行的 sudo，或属于 root 的 `ssh`、`ssh-add`、`scp`、`sftp`、`git-remote-http(s)`（git 的 HTTPS 辅助程序）可执行文件所启动的 `bin/askpass` 请求。其他来源一律拒绝，例如命令自己运行 `$SUDO_ASKPASS` 来读取你的回答。
- 面板会显示实际请求密码的命令，回答前请先确认：`ssh` 或 `git` 命令会把你的回答发送到它指定的服务器。
- 限制：以你自己的用户身份运行的恶意程序，有机会在真正的请求进行时抢先读走回复。cc-askpass 的目标是正常使用时不让密码进入模型的 context，它不是防范同一用户下恶意程序的沙箱。

## 限制

- `su` 和 `doas` 不支持 askpass，请改用 sudo。
- polkit（`pkexec`、`run0`、以普通用户运行 `systemctl`）会直接报错“Interactive authentication required”而不会询问。
- 不处理 y/n 之类的提问，请使用 `-y`、`--no-interaction` 等参数。
- 遮盖输入可以在输入框任何位置输入，但在中间删除的字符会被当成删掉末尾的字符。如果在中间编辑过，请按 Show 确认，或清空后重新输入。
- 在没有图形界面的主机上，`DISPLAY=:0` 这个占位值可能让少数图形程序（例如 `xdg-open`）尝试连接 X server 而失败。
- 移动端 app（以及从手机使用 Remote Control）无法显示输入框，请改在终端或桌面版 app 回答。
- 非交互模式（`claude -p`、SDK）下没有人能回答，mod 不会启动，sudo 会和没装 mod 时一样直接失败。
- 开启 Bash 沙箱时，sudo 无法提权，helper 也看不到监听程序，会立即以“the cc-askpass listener is not running”失败。
- ssh 的确认提示（`SSH_ASKPASS_PROMPT=confirm`）会以普通文本输入的形式出现。

## 卸载

```sh
claude plugin uninstall cc-askpass
```

如果你添加了 sudoers 配置文件，请用 `sudo rm /etc/sudoers.d/cc-askpass` 删除。

## 开发

```sh
sh tests/askpass.sh                            # helper 测试（Linux、WSL、macOS）
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用这份源码启动 Claude Code
npx -p typescript tsc -p .                     # 类型检查（先用 --plugin-dir 加载过一次）
```

## 许可证

[MIT](LICENSE)
