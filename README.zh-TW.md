# cc-askpass

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md)

Claude Code 的 Bash 工具執行指令時沒有終端機，所以指令需要 sudo 密碼時，sudo 會直接放棄：

```
sudo: a terminal is required to read the password; either use the -S option ...
```

cc-askpass 是一個 Claude Code mod，會在 Claude Code 裡跳出密碼面板來回應這些提示。密碼直接交給 sudo，不會進入模型的 context。

涵蓋範圍：sudo（包含腳本和安裝程式裡呼叫的 sudo）、ssh 金鑰密碼，以及透過 HTTPS 的 git 帳號密碼。

## 需求

- Claude Code 2.1.289 以上
- Linux 或 WSL。macOS 理論上可用，但未經測試。不支援 Windows 原生版。

## 安裝

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

接著重新啟動 Claude Code，或執行 `/reload-plugins`。不需要任何設定。

## 使用方式

請 Claude 執行任何需要 sudo 的指令，就會跳出 **sudo password** 面板，並顯示是哪個指令在要求密碼（例如 `sudo apt update`）。輸入密碼後按 Enter。

- **Show/Hide** 可以顯示你輸入的內容。sudo 一律遮罩；其他提示也預設遮罩，只有 git 的 `Username for '...'` 和 ssh 第一次連線的 `(yes/no)` 確認例外。
- **Cancel** 或 Esc 代表不回答，sudo 會顯示「no password was provided」並結束。
- 密碼打錯時會再問一次，並提示「Sorry, try again」。
- 終端機寬度不到 144 欄時，面板可能不會自動跳出，這時 status line 會顯示 `sudo is waiting for a password — type /askpass`。輸入 `/askpass` 即可開啟，Claude 執行中也能用。

## 一段時間內只問一次

Claude 執行的每個 Bash 指令都是新的行程，所以 sudo 每次都會再問密碼。cc-askpass 不會暫存密碼，因為以你的身分執行的任何程式都可能讀到暫存的密碼。若想讓 sudo 記住「已經驗證過」，請執行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 並加入：

```
Defaults:你的使用者名稱 timestamp_type=global
```

這樣 sudo 會在所有終端機和 Claude Code session 之間共用同一個時間戳記，有效期間是 sudo 原本的逾時時間（預設 15 分鐘），cc-askpass 在這段期間只會問一次。

## 運作方式

```
Claude 的 Bash 指令 → sudo → bin/askpass → 請求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回覆 FIFO ←──────────────┘
```

session 開始時，mod 會啟動一個小型監聽程式（`bin/askpass --serve`），並為 Claude 執行的指令設定這些環境變數：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本沒有設定時補上 `DISPLAY=:0`（sudo 只有在設定了 `DISPLAY` 時才會使用 askpass）。sudo 接著執行 `bin/askpass`，它透過 `$XDG_RUNTIME_DIR/cc-askpass/<session>/`（權限 0700）裡的 FIFO 把提示交給 mod。mod 用 `ps` 確認請求真的來自 `bin/askpass`，跳出面板，再把你的回答寫進該 helper 專屬的 FIFO。

## 安全性

- 密碼不會寫入模型的 context、log、toast、status line、指令參數或任何檔案。
- 不是來自 `bin/askpass` 的請求會被拒絕；面板也會顯示實際要求密碼的指令，所以指令無法偽造 sudo 提示來騙取密碼。
- 限制：以你自己的使用者身分執行的惡意程式，有機會在真正的請求進行時搶先讀走回覆。cc-askpass 的目標是正常使用下不讓密碼進入模型的 context，它不是防範同一使用者底下惡意程式的沙箱。

## 限制

- `su` 和 `doas` 不支援 askpass，請改用 sudo。
- polkit（`pkexec`、`run0`、以一般使用者執行 `systemctl`）會直接顯示「Interactive authentication required」而不會詢問。
- 不處理 y/n 之類的提問，請使用 `-y`、`--no-interaction` 等參數。
- 遮罩輸入只追蹤在欄位尾端的輸入和刪除。如果移動了游標，請按 Show 確認，或清空後重新輸入。
- 在沒有圖形介面的主機上，`DISPLAY=:0` 這個假值可能讓少數圖形程式（例如 `xdg-open`）嘗試連線 X server 而失敗。
- 行動版 app 無法顯示輸入欄位，請改在終端機或桌面版 app 回答。
- ssh 的確認提示（`SSH_ASKPASS_PROMPT=confirm`）會以一般文字輸入的形式出現。

## 移除

```sh
claude plugin uninstall cc-askpass
```

如果你有加入 sudoers 設定檔，請用 `sudo rm /etc/sudoers.d/cc-askpass` 刪除。

## 開發

```sh
sh tests/askpass.sh                            # helper 測試（Linux/WSL）
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用這份原始碼啟動 Claude Code
```

## 授權

[MIT](LICENSE)
