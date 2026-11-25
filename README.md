# Hermes Paseo plugin

Hermes Agent / Web 插件：啟用後準備固定 Paseo runtime，在受保護的插件頁完成官方加密 relay 配對（可選 Paseo、Woowtech Smart 或 Apporo Smart），於所選的網頁 App 選取 Hermes ACP 模型並建立及接續對話。目前版本 **0.1.5-rc.1**。

公開 repo：<https://github.com/WOOWTECH/hermes-paseo-plugin>。下載不需要 GitHub 帳號或 token。

Gitea 原始碼鏡像：<https://git-prod.woowtech.io/mirror/hermes-paseo-plugin>。每 8 小時從 GitHub 拉取 Git 分支與標籤；Release 說明及附件仍以 GitHub 為準。

完整中文教學：[下載、安裝、部署與測試](docs/install.zh-TW.md)。

**0.1.5-rc.1 新增連線標的**（見下方 [連線標的](#連線標的)）：在插件頁選擇 daemon 使用 Paseo、Woowtech Smart 或 Apporo Smart 的 relay 與網頁 App，預設仍是 Paseo，而且沒有人儲存標的之前，插件的行為與 0.1.4-rc.9 完全相同。本版**不更動 daemon，也不更動 runtime 鎖定檔**：受管 daemon 仍是 Paseo 0.11.2，`runtime/package.json` 與 `runtime/package-lock.json` 與 0.1.4-rc.9 位元組相同，已安裝的 runtime 不會重新下載或重新執行 `npm ci`。

目前為公開預覽版本。部署到正式環境前，請在自己的主機完成 Web 安裝／啟用、官方配對及首輪／續聊驗收；各版本的支援範圍與驗收方式見 [實測紀錄](docs/validation.md)。

2026-10-26 最新重測：PaaS `.263` 已透過服務專用版本固定及原生 Redeploy，將測試站升至 chart `0.4.0`。Dashboard adapter、原 Hermes 映像、CPU 限制與 10 GiB 磁碟均保留；原配對、部署前對話的記憶續聊、官方 Paseo 新對話與 Dashboard 重載期間的背景驗收通過。平台部署模板整合已完成此環境的實測。

同日追加 [官方 Paseo Web 詳細測試](docs/web-acceptance-20261026.zh-TW.md)：新裝置配對、手機模擬續聊、即時模型／模式切換、中止、雙裝置並行、明確斷線後重連與歷史歸檔通過。附件首測因缺少檔案工具失敗；使用者核准後已啟用原生 `file` 工具，工具載入及原生讀寫測試通過。模型附件回覆與還原後續聊仍待訂閱 HTTP 429 額度恢復後重測，不能宣稱所有功能正常。

測試站使用自己已授權的 Hermes `openai-codex:gpt-6.1-sol`，另已通過三路並行共六段對話、插件資料還原及可控跨節點搬移。早期 0.8B 本機模型的失敗紀錄保留於驗收文件。此版本可公開下載試用；長期負載、整機災難復原及其他環境仍待驗收。

0.1.4-rc.3 加入由管理者設定的第二個精確 HA Ingress Origin；原本的 Dashboard Origin 與登入保留。HA add-on **0.1.11** 已發布並同步至 [HA App Store](https://github.com/WOOWTECH/Woow_HA_App_Store)。隔離 HAOS 完成原生安裝、官方配對、HA 側欄、Dashboard 重載、真實對話與附件、停用／重啟，以及正式映像升級的資料保留驗證；公開 Gitea URL 也通過原生 Web 安裝。rc.4 補上攔截回覆的錯誤分類。後續八輪實測全部通過：新舊 DeepSeek 對話、Xiaomi 切換與冷啟動續聊，以及官方商店成品的新配對、附件讀取和加密備份還原後續聊；首次新增 project 的必要步驟已補進教學。先前攔截回覆的上游根因仍未確診。詳細範圍見 [HA 驗收報告](docs/ha-acceptance-20261026.zh-TW.md) 與 [HA 安裝步驟](docs/install.zh-TW.md#home-assistant-add-on)。

## 安裝與配對

在 Hermes Web 的插件頁選擇從 GitHub 安裝，輸入 `WOOWTECH/hermes-paseo-plugin`。CLI：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin
hermes plugins enable hermes-paseo
```

原生 Agent 插件與 Dashboard 頁面均包含在同一 repo。啟用後開啟 Paseo 頁面，按引導準備服務；預設標的是 Paseo，也可先選 Woowtech Smart 或 Apporo Smart（見下節）。產生配對連結後，在新分頁開啟該標的的官方網頁 App，按 Connect 完成綁定。全新 Paseo 裝置若顯示 No projects yet，先用 Add project 選擇或建立工作目錄，再於 New workspace 選定 project、Hermes、模型與權限模式。

配置 0.1.4 主機介面時，仍啟用的服務在容器啟動後會準備 runtime，並在 daemon 意外中斷後恢復，不需開啟瀏覽器。手動停止的狀態會保留；Hermes Web 停用／移除插件前也會先確認服務停止。未配置主機介面時，仍使用可見 Web 頁面的恢復流程，CLI 移除前須先停止服務。

文字對話服務預設不下載額外語音模型，保留使用者既有的明確語音啟用設定。主機介面另依容器 CPU quota 設定本機推理的預設執行緒數，保留管理者明確的環境設定。

首次安裝的後端 API 是否能立即使用，依 Hermes 版本而異。Paseo 頁提供「重載 Dashboard → 確認重載」；配置好主機介面後，即使插件 API 尚未載入也可使用，完成後自動回到目前頁面。管理者須先完成一次性 [Dashboard 主機設定](docs/dashboard-control.zh-TW.md)；未配置主機會停用此按鈕並說明原因。

Hermes 0.19 的 Web 插件列表只在頁面載入時讀取。從插件頁安裝或啟用後，請重新整理一次；插件載入後會自動開啟尚未完成的配對指南。

官方 relay 不需要額外 Paseo 密碼。缺少模型登入時，使用 Hermes 的官方模型／登入設定；不要將密碼、OAuth token 或配對連結貼到聊天中。插件不讀取或複製模型憑證。

## 連線標的

插件頁的 **連線標的** 選擇 daemon 使用哪一組 relay 與網頁 App，做法與 Pi 的 Agent Connect 相同：

| 標的 | 網頁 App | relay |
|---|---|---|
| Paseo（預設） | `https://app.paseo.sh` | `relay.paseo.sh:443` |
| Woowtech Smart | `https://smart.woowtech.io` | `relay.woowtech.io:443` |
| Apporo Smart | `https://smart.apporo.ai` | `relay.apporo.ai:443` |

- **選擇才生效，沒選就什麼都不改**：沒有人儲存過標的之前（`plugin-data/hermes-paseo/connection.json` 不存在）插件處於「舊模式」，行為與 0.1.4-rc.9 完全相同：啟動 daemon 時不寫入 `app.baseUrl`、`daemon.relay`、CORS，不補丁 runtime，不備份、不刪除任何檔案，`config.json` 與 runtime 目錄逐位元組不變；狀態顯示 Paseo（`targetSaved` 為 false），配對與 rc.9 一樣只核對網頁 App 網址、不核對 relay。第一次按 **儲存連線標的**（選 Paseo 也算）才進入「管理模式」，從下一次啟動 daemon 起才寫入所選標的的設定。
- **預設與升級**：沒有人儲存連線標的之前，標的是 Paseo。手動更新（從 GitHub 安裝或 Git pull，並重載 Dashboard）不會重啟執行中的 daemon；**PaaS 自動更新器會**：它依序執行 `control stop`、安裝新版、`control start`，所以 daemon 會以新程式碼重啟一次。這次重啟與 rc.9 的啟動相同，什麼都不會改變；連線標的與品牌補丁要等有人在插件頁儲存標的之後的下一次停止再啟動才套用。仍在執行的舊 daemon 視為 Paseo，runtime 不會重新下載或重新執行 `npm ci`。
- **儲存只是記錄**：選好後按 **儲存連線標的**，選擇存入 `plugin-data/hermes-paseo/connection.json`；這個動作不會詢問或改動執行中的 daemon，也不取用長時間的 runtime 鎖。標的有變時，頁面顯示「標的已儲存，停止再啟動服務後生效」：先結束使用中的對話，按 **停止服務**，待停止完成再按 **恢復服務**，新標的才套用，之後才能產生它的配對連結。在那之前配對與 relay 驗證都會回報 `CONFIGURATION_PENDING`。
- **切換保留身分**：切換標的會作廢舊的配對連結與 relay 驗證結果；daemon 的 server ID 與金鑰保留，已配對的裝置在切回同一標的後仍可使用。
- **套用的內容（管理模式）**：每次啟動 daemon 時，插件依所選標的寫入 `app.baseUrl`、`daemon.relay`（`endpoint`、`publicEndpoint`、`useTls`、`publicUseTls`，TLS 明確寫出）與 `daemon.cors.allowedOrigins`；不屬於這三個標的的 CORS 來源保留，三個 App 的來源以 `URL.origin` 比對（大小寫、預設連接埠、結尾斜線不同的寫法視為同一個，不會重複列出）。不寫入 `daemon.relay.requireProtectedSecurity`（Paseo 0.11.2 的嚴格設定檔不認得它）。
- **一次性備份**：進入管理模式後，第一次為所選標的改寫 `config.json` 之前，插件把它複製成同目錄的 `config.json.pre-agent-connect`（權限 600、一般檔案）。只做一次，不覆蓋任何已存在的備份（不論那是什麼），不經過符號連結；沒有 `config.json` 就沒有可備份的內容。備份失敗時（`CONFIG_BACKUP_FAILED`、`UNSAFE_SYMLINK`）不改寫 `config.json`，也不啟動 daemon。**還原**：先按 **停止服務**，確認已停止，再在服務帳戶下執行：

  ```bash
  cd "$HERMES_HOME/plugin-data/hermes-paseo/daemon"
  cp -p config.json.pre-agent-connect config.json
  rm -f ../connection.json     # 回到「沒選過標的」的舊模式；留著它，下一次啟動又會寫入所選標的的設定
  ```

  最後按 **恢復服務**。自訂的 relay 或 App 網址只會在舊模式下被保留。
- **管理模式會覆蓋自訂的 relay 與 App 網址**：管理模式下，每次啟動 daemon 都用所選標的（Paseo 也一樣）的值寫入這些欄位，所以 `config.json` 裡手動改過的 relay 或 App 網址會在下一次啟動被取代，不只是切換時。需要自訂值的人，不要儲存連線標的；已經儲存過的，先備份 `plugin-data/hermes-paseo/daemon/config.json`（第一次改寫前插件已幫你留了一份，見上）。
- **品牌識別**：Woowtech／Apporo Smart 的網頁 App 要求 daemon 的握手帶有 `brand: {id, name}`。只有選這兩個標的時，插件才會在啟動 daemon 前，以雜湊釘住的小補丁在已安裝的 runtime 內就地修改 daemon 的 `websocket-server.js` 一個檔案並放置一個輔助檔，讓握手帶有所選標的的品牌（補丁內容與驗證見[維運文件](docs/operations.zh-TW.md#品牌識別補丁與升級)）。Paseo 不需要補丁，也不要求補丁：`websocket-server.js` 被改過、讀不到或唯讀，都不會影響預設的 Paseo 啟動；已補丁的 runtime 對 Paseo 保持原樣。已執行的舊 daemon 不會被補丁影響，補丁在下次啟動前才套用。補丁與 `npm ci` 無關：補丁失敗不會讓下一次啟動重新安裝 runtime。
- **配對連結**只會是所選標的的網頁 App（`<網頁 App>/#offer=…`），而且不會寫入任何檔案；舊版留下的 `pairing.private.json` 會在儲存標的時與管理模式啟動時刪除（舊模式不刪）。
- **回滾到 0.1.4-rc.9**：從沒儲存過標的的服務不需要任何動作，直接降版。已儲存過的，先在插件頁切回 **Paseo**，停止再恢復服務，確認配對連結是 `app.paseo.sh`，再降版。rc.9 接受已補丁的 runtime（它只檢查鎖定檔與 CLI 版本），但只放行 `app.paseo.sh` 的配對連結；daemon 仍是 Smart 標的時，rc.9 的 daemon 能啟動，卻會拒絕產生配對連結（`PAIRING_ORIGIN_INVALID`）。

## 在 Hermes 對話調用插件

插件提供 `paseo_status`、`paseo_start`、`paseo_stop`、`paseo_models`、`paseo_chat`、`paseo_continue`。若 profile 已限定工具集，請在 Hermes 工具設定將 `hermes_paseo` 納入需要使用的工具集；插件保留原有白名單，不會改成全部開放。

單次 CLI 對話可明確選用：

```bash
hermes chat --toolsets hermes_paseo --query "請用 paseo_status 查看連線狀態"
```

也可用 `/paseo` 查看引導，`/paseo status`、`/paseo start`、`/paseo stop` 直接控制。配對邀請由受保護的 Dashboard 頁面取得。

## 環境與資料

Linux、Python 3.11+、Node.js 22.19.0+、npm、util-linux flock；Hermes 須支援原生 Dashboard plugins 與 `hermes acp`，並已安裝 ACP extra。插件不自動替換 Hermes 核心或 Python 環境。

每個 Hermes profile 的 plugin-data/hermes-paseo 存放 runtime、Paseo home、狀態與初始化紀錄；不與 Pi plugin 或使用者原來的 Paseo home 混用。停止後保留手動暫停、登入與對話資料。Hermes 0.19 沒有公開卸載 callback，停用／移除插件前請先在 Paseo 頁按「停止服務」，或執行 `/paseo stop`，確認 `/paseo status` 中 `daemon.running=false` 後再停用；此版本不宣稱停用按鈕會自動清理背景 daemon。其他同容器已安裝的 Claude Code、Codex、Pi 會被偵測；缺少或未登入的 provider 不宣稱能對話。

狀態與診斷不等同真正模型回覆；對話驗收會使用帳號額度，完成後歸檔此次測試 agent、保留紀錄。配對 URL 只在受保護設定頁傳遞，不寫入任何檔案，API 使用 no-store/no-referrer。

入口代理若清空 Origin 或改寫 Host，必須先驗證允許的正式 Origin，並保留／拒絕瀏覽器 cross-site Fetch Metadata；不可只依靠重寫後的後端 Origin 判斷。

若 HTTPS 入口經 HTTP 代理後遺失原本協定或 Host，由管理者使用 Hermes 服務帳戶為該 profile 設定正式 Origin：

```bash
python3 ~/.hermes/plugins/hermes-paseo/bin/configure-origin.py https://hermes.example.com
```

自訂 `HERMES_HOME` 時請改用該 profile 下的插件路徑，並沿用相同環境。設定寫入私有 `plugin-data/hermes-paseo/dashboard-origin.json`，要求本帳戶擁有、無其他帳戶讀寫權限；禁止 credentials、path、query、fragment。插件只接受這個精確 Origin，仍拒絕 cross-site Fetch Metadata，不信任客戶端任意 Forwarded 標頭。這個設定不包含密碼，也不更改 Hermes 登入。

## 開發驗證

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py'
node --check dashboard/dist/index.js
npm audit --omit=dev --prefix runtime
```

需要 `python3`（3.11+）在 `PATH` 上：`tests/target-parity.test.mjs` 以 `python3` 讀取橋接檔的標的表，與 Node 端及 Dashboard 的三份表比對；Python 單元測試另需 `fastapi`、`httpx` 與 `PyYAML`（CI 安裝同一組）。

[維運與可重複驗收](docs/operations.zh-TW.md) 包含有上限的真實並行測試工具，以及已實測的插件備份還原範圍。部署及實測結果會記錄於 docs/validation.md。各平台的登入與額度會變化，必須以新的首輪及續聊驗證為準。

## 官方介面

- [Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)
- [Paseo Hermes ACP](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)

MIT；Paseo runtime 隔離、程序擁有權及狀態鎖實作沿用 WOOWTECH Pi Paseo plugin 0.1.3，見 NOTICE.md。
