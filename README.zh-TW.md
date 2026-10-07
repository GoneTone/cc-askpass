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

請 Claude 執行任何需要 sudo 的指令，就會跳出 **sudo password** 面板，並完整顯示將以 root 執行的指令（例如 `$ sudo apt update`）。如果 sudo 是由 Claude 執行的其他東西間接呼叫的，例如 `./install.sh` 或 `curl … | bash`，還會多一行 `Claude ran:` 顯示那個指令。輸入密碼後按 Enter。

- **Show/Hide** 可以顯示你輸入的內容。sudo 一律遮罩；其他提示也預設遮罩，只有 git 的 `Username for '...'` 和 ssh 第一次連線的 `(yes/no)` 確認例外。
- **Cancel** 或 Esc 代表不回答，sudo 會顯示「no password was provided」並結束。
- 密碼打錯時會再問一次，並提示「Sorry, try again」。
- 如果面板出現時你正在輸入框打字（或有對話框開著），面板就拿不到鍵盤。這時它會用紅字提示：先點一下面板（或按 ctrl+x tab；非 fullscreen 模式只能用按鍵）再輸入，免得密碼打進輸入框、被當成訊息送給 Claude。
- 面板出現在哪裡由 Claude Code 決定：fullscreen 模式且寬度 110 欄以上時停靠在對話記錄旁邊，其他情況出現在提示列上方。
- 終端機寬度不到 144 欄時，面板可能不會自動跳出，這時提示列上方會顯示 `sudo is waiting for a password — click the button below or type /askpass`，下方有一個 **Open password prompt** 按鈕。點按鈕或輸入 `/askpass` 即可開啟，Claude 執行中也能用。非 fullscreen 模式下終端機不支援滑鼠點擊，這行提示會改成請你按 ctrl+x tab（鍵盤會移到按鈕上）再按 Enter，或輸入 `/askpass`。

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

session 開始時，mod 會啟動一個小型監聽程式（`bin/askpass --serve`），並為 Claude 執行的指令設定這些環境變數：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本沒有設定時補上 `DISPLAY=:0`（sudo 只有在設定了 `DISPLAY` 時才會使用 askpass；`CC_ASKPASS_SET_DISPLAY=1` 標記這是 mod 設的）。sudo 接著執行 `bin/askpass`，它透過 `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/`（權限 0700）裡的 FIFO 把提示交給 mod。mod 用 `ps` 確認請求真的來自 `bin/askpass`，跳出面板，再把你的回答寫進該 helper 專屬的 FIFO。監聽程式運作期間，mod 也會在 Claude 的 system prompt 加一段說明，告訴它 sudo 可以詢問密碼，所以 Claude 會直接執行 `sudo`，而不是改用 `sudo -n` 或請你自己執行。

## 安全性

- 密碼不會寫入模型的 context、log、toast、status line、指令參數或任何檔案。
- 只接受由 root 身分的 sudo，或屬於 root 的 `ssh`、`ssh-add`、`scp`、`sftp`、`git-remote-http(s)`（git 的 HTTPS 輔助程式）執行檔所啟動的 `bin/askpass` 請求。其他來源一律拒絕，例如指令自己執行 `$SUDO_ASKPASS` 來讀取你的回答。
- 面板會顯示實際要求密碼的指令，回答前請先確認：`ssh` 或 `git` 指令會把你的回答送到它指定的伺服器。
- 限制：以你自己的使用者身分執行的惡意程式，有機會在真正的請求進行時搶先讀走回覆。cc-askpass 的目標是正常使用下不讓密碼進入模型的 context，它不是防範同一使用者底下惡意程式的沙箱。

## 限制

- `su` 和 `doas` 不支援 askpass，請改用 sudo。
- polkit（`pkexec`、`run0`、以一般使用者執行 `systemctl`）會直接顯示「Interactive authentication required」而不會詢問。
- 不處理 y/n 之類的提問，請使用 `-y`、`--no-interaction` 等參數。
- 遮罩輸入可以在欄位任何位置輸入，但在中間刪除的字元會被當成刪掉尾端的字元。如果在中間編輯過，請按 Show 確認，或清空後重新輸入。
- 在沒有圖形介面的主機上，`DISPLAY=:0` 這個假值可能讓少數圖形程式（例如 `xdg-open`）嘗試連線 X server 而失敗。
- 行動版 app（以及從手機使用 Remote Control）無法顯示輸入欄位，請改在終端機或桌面版 app 回答。
- 非互動模式（`claude -p`、SDK）下沒有人能回答，mod 不會啟動，sudo 會和沒裝 mod 時一樣直接失敗。
- 開啟 Bash 沙箱時，sudo 無法提權，helper 也看不到監聽程式，會立刻以「the cc-askpass listener is not running」失敗。
- ssh 的確認提示（`SSH_ASKPASS_PROMPT=confirm`）會以一般文字輸入的形式出現。
- 在 macOS 上，確認 ssh／git 呼叫者是 root 擁有的真正執行檔的檢查改用 `lsof`，而不是 Linux 的 `/proc`。這部分未經測試；檢查失敗時會拒絕該提示。sudo 不依賴這個檢查。

## 移除

```sh
claude plugin uninstall cc-askpass
```

如果你有加入 sudoers 設定檔，請用 `sudo rm /etc/sudoers.d/cc-askpass` 刪除。

## 開發

```sh
sh tests/askpass.sh                            # helper 測試（Linux、WSL、macOS）
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用這份原始碼啟動 Claude Code
npx -p typescript tsc -p .                     # 型別檢查（先用 --plugin-dir 載入過一次）
```

## 授權

[MIT](LICENSE)
