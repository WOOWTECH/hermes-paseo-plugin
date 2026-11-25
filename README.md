# Hermes Paseo plugin

Hermes Agent / Web 插件：啟用後準備固定 Paseo runtime，在受保護的插件頁選擇連線標的（Paseo、Woowtech Smart 或 Apporo Smart）並完成該平台的加密 relay 配對，於官方網頁選取 Hermes ACP 模型並建立及接續對話。

公開 repo：<https://github.com/WOOWTECH/hermes-paseo-plugin>。下載不需要 GitHub 帳號或 token。

Gitea 原始碼鏡像：<https://git-prod.woowtech.io/mirror/hermes-paseo-plugin>。每 8 小時從 GitHub 拉取 Git 分支與標籤；Release 說明及附件仍以 GitHub 為準。

完整中文教學：[下載、安裝、部署與測試](docs/install.zh-TW.md)。

## 連線標的（0.2.0-rc.1 起）

功能與 Pi Agent 的 Agent Connect 0.1.24 相同：在 Hermes Dashboard 的 Paseo 頁選擇標的，daemon 改用該標的的 relay 與官方網頁。既有安裝維持 **Paseo**，有人選了其他標的才會改變。

| 標的 | 官方網頁 | relay |
| --- | --- | --- |
| Paseo（預設） | https://app.paseo.sh | relay.paseo.sh:443 |
| Woowtech Smart | https://smart.woowtech.io | relay.woowtech.io:443 |
| Apporo Smart | https://smart.apporo.ai | relay.apporo.ai:443 |

- 在 **2. 配對精靈** 選擇並按「儲存連線標的」。服務執行中時新標的顯示「等待套用」：先結束使用中的對話，按「停止服務」再按「恢復服務」才會套用；套用前不產生配對連結，也不做 relay 驗證。服務已停止時，下次啟動就會套用。
- 切換會清除已存的配對連結與 relay 驗證紀錄，保留 daemon 的 server ID 與金鑰：已配對的裝置不會被撤銷，原標的的裝置切回原標的後仍可使用。每台主機一次連接一個標的。
- 選擇存在私有的 `plugin-data/hermes-paseo/connection.json`。0.1.4 會讀取 `preferences.json`，插件不寫入它，退回 0.1.4 時 daemon 仍能啟動。
- daemon 的 `config.json` 依標的寫入 `app.baseUrl`、`daemon.relay`（endpoint、publicEndpoint、TLS）與 `daemon.cors.allowedOrigins`；不屬於三個官方網頁的 CORS 來源保留。受管的 `paseo daemon start` 會丟棄 `PASEO_*` 設定環境變數（0.11.2 與 0.17.4 皆然），所以由 `config.json` 決定。
- Woowtech／Apporo Smart 網頁在 hello 時要求 daemon 宣告品牌。插件在受管的 0.17.4 runtime 套用與 Agent Connect 相同的 `server_info` 修補（以 `HERMES_PASEO_CONNECTION_TARGET` 決定品牌），修補前後都核對 SHA-256。
- Smart App 只支援舊版 relay 加密：Smart 標的會移除 `daemon.relay.requireProtectedSecurity`（等同關閉），要求新版加密的配對邀請以 `PAIRING_SECURITY_UNSUPPORTED` 拒絕。Paseo 標的保留使用者自己的設定。
- 頁面的「開啟 <標的>」開啟所選標的官方網頁；配對連結只接受該標的的精確來源、路徑 `/` 與 `#offer=`。Smart App 的行動推播（品牌專屬 FCM）不在此整合範圍。

## 0.2.0-rc.1：Paseo 0.17.4 與升級

受管 daemon 由 `@getpaseo/cli` 0.11.2 升到 **0.17.4**（runtime revision `0.17.4-r1-09cdbfab2022`，依賴與 Agent Connect 0.1.24 相同的 lockfile，`npm audit` 0 項）。下載約 400 MB；安裝高峰約 **1.5 GB**（npm 快取約 0.4 GB 加解開後約 1.1 GB），裝完移除快取與用不到的 musl 版 Claude SDK（約 0.34 GB），版本目錄穩態約 **0.75 GB**。

**升級採「需要重新啟動」的可見步驟，不自動重啟。** 插件更新後，仍在執行的 0.11.2 daemon 繼續服務：狀態、配對、設定重新載入與停止都交給它自己的 0.11.2 版本目錄（`0.11.2-r2-71709cd7872f`），頁面顯示「需要重新啟動」。插件同時在背景安裝 0.17.4，並以 0.17.4 自己的讀取器檢查目前的 `config.json`（等同 `bin/control.mjs prepare`：不啟動、不停止任何 daemon，見[維運](docs/operations.zh-TW.md#預先準備新版prepare)）。結束使用中的對話後按「停止服務」再按「恢復服務」，同一個 `PASEO_HOME` 改由 0.17.4 執行；設定、對話資料、server ID 與 daemon 金鑰保留。理由：

- PaaS 自動更新器本身就是「舊版程式停止 → 安裝 → 新版程式啟動」，插件不需要也不應該再自行重啟。
- HA 從 Hermes Plugins 以 Git pull 更新，Dashboard 重載不會停止獨立的 daemon；自動重啟會中斷進行中的代理回合。重啟附加元件時容器內所有程序重開，daemon 會直接以新版啟動。

0.17.4 若無法讀取目前設定，頁面顯示「需要修正設定」並列出不相容的設定**路徑**（只有鍵的路徑，不含內容），「停止服務」會被拒絕以避免停止後無法再啟動；被拒絕的停止不會留下暫停，daemon 與配對照常。處理方式：

- 設定檔是 `$HERMES_HOME/plugin-data/hermes-paseo/daemon/config.json`（PaaS 與 HA 預設 `HERMES_HOME=/opt/data`，即 `/opt/data/plugin-data/hermes-paseo/daemon/config.json`）。
- 路徑清單也可由命令列取得：`node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" status <<< '{}'` 的 `configCheck.paths`。
- 備份後移除或改正那些路徑；頁面讀取狀態時會自動重新檢查，通過後再按「停止服務」與「恢復服務」。
- 不想修正、只想停用或移除插件：Hermes Web 的停用／移除**不受這項檢查阻擋**，daemon 會被直接停止。細節見[維運](docs/operations.zh-TW.md#設定不相容停止被拒絕與處理方式)。

- **退回 rc.9**：rc.9 可停止 0.17.4 daemon 並以 0.11.2 重新啟動（已實測）。但 0.17.4 會把代理紀錄的 `config.featureValues` 改寫成 `controls`，退回後這些代理選項（例如思考等級）會遺失、需重新選擇；選了 Smart 標的時要先切回 Paseo。
- **0.17.4 新預設，插件維持原樣不覆寫**：`agents.idleRuntimeCleanup` 會在代理閒置 60 分鐘後關閉其執行環境，下次訊息再啟動接續；`daemon.usage.enabled` 讓內建 Claude／Codex 用量來源讀取 `~/.claude/.credentials.json`、`~/.codex/auth.json` 並呼叫 Anthropic／ChatGPT 用量 API（0.11.2 已內含、只是沒有開關）。不寫入的原因：0.11.2 的嚴格設定不認得這兩個鍵，寫入後就無法退回 rc.9。
- **停止**：0.17.4 停止時最多等 worker 約 10 秒、每個終端機約 5＋3 秒，並以 procps `ps` 清理終端機程序；插件的停止上限為 45 秒（bridge 120 秒）。PaaS 的自動更新器（chart 0.4.7–0.4.9）只接受 `runtime/` 位元組不變的版本，會以 `dependency_manifest_changed` 拒絕本版，需另外協調；`host/` 主機轉接檔沒有變更，HA 不需要新的附加元件版本。退回、0.17.4 的新預設與停止時間等細節見 [維運](docs/operations.zh-TW.md#020-rc1-升級退回與-paseo-0174)。

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

原生 Agent 插件與 Dashboard 頁面均包含在同一 repo。啟用後開啟 Paseo 頁面，按引導準備服務；需要時先選擇並儲存連線標的，再產生配對，在新分頁開啟所選平台的官方網頁，按 Connect 完成綁定。全新 Paseo 裝置若顯示 No projects yet，先用 Add project 選擇或建立工作目錄，再於 New workspace 選定 project、Hermes、模型與權限模式。

配置 0.1.4 主機介面時，仍啟用的服務在容器啟動後會準備 runtime，並在 daemon 意外中斷後恢復，不需開啟瀏覽器。手動停止的狀態會保留；Hermes Web 停用／移除插件前也會先確認服務停止。未配置主機介面時，仍使用可見 Web 頁面的恢復流程，CLI 移除前須先停止服務。

文字對話服務預設不下載額外語音模型，保留使用者既有的明確語音啟用設定。主機介面另依容器 CPU quota 設定本機推理的預設執行緒數，保留管理者明確的環境設定。

首次安裝的後端 API 是否能立即使用，依 Hermes 版本而異。Paseo 頁提供「重載 Dashboard → 確認重載」；配置好主機介面後，即使插件 API 尚未載入也可使用，完成後自動回到目前頁面。管理者須先完成一次性 [Dashboard 主機設定](docs/dashboard-control.zh-TW.md)；未配置主機會停用此按鈕並說明原因。

Hermes 0.19 的 Web 插件列表只在頁面載入時讀取。從插件頁安裝或啟用後，請重新整理一次；插件載入後會自動開啟尚未完成的配對指南。

官方 relay 不需要額外 Paseo 密碼。缺少模型登入時，使用 Hermes 的官方模型／登入設定；不要將密碼、OAuth token 或配對連結貼到聊天中。插件不讀取或複製模型憑證。

## 在 Hermes 對話調用插件

插件提供 `paseo_status`、`paseo_start`、`paseo_stop`、`paseo_models`、`paseo_chat`、`paseo_continue`。若 profile 已限定工具集，請在 Hermes 工具設定將 `hermes_paseo` 納入需要使用的工具集；插件保留原有白名單，不會改成全部開放。

單次 CLI 對話可明確選用：

```bash
hermes chat --toolsets hermes_paseo --query "請用 paseo_status 查看連線狀態"
```

也可用 `/paseo` 查看引導，`/paseo status`、`/paseo start`、`/paseo stop` 直接控制。配對邀請由受保護的 Dashboard 頁面取得。

## 環境與資料

Linux、Python 3.11+、Node.js 22.19.0+、npm、util-linux flock、procps `ps`（Paseo 0.17.4 停止時用來清理終端機程序）；Hermes 須支援原生 Dashboard plugins 與 `hermes acp`，並已安裝 ACP extra。插件不自動替換 Hermes 核心或 Python 環境。

**磁碟**：安裝新 runtime 的高峰需要約 **1.5 GB** 可用空間，完成後約 **0.75 GB**，升級期間舊版 runtime（0.11.2，約 0.8 GB）在新版 daemon 啟動前仍在碟上。PaaS chart 的預設資料碟只有 5 GiB，且與 Hermes 自己的資料共用。安裝前先檢查可用空間，不足時以 `INSUFFICIENT_DISK` 拒絕（狀態的 `prepare` 欄位帶所需與可用的 MiB），舊 daemon 完全不受影響；失敗或被中斷的安裝會整個移除，不留看起來已就緒的半成品。

每個 Hermes profile 的 plugin-data/hermes-paseo 存放 runtime、Paseo home、連線標的、狀態與初始化紀錄；不與 Pi plugin 或使用者原來的 Paseo home 混用。停止後保留手動暫停、登入與對話資料。Hermes 0.19 沒有公開卸載 callback，停用／移除插件前請先在 Paseo 頁按「停止服務」，或執行 `/paseo stop`，確認 `/paseo status` 中 `daemon.running=false` 後再停用；此版本不宣稱停用按鈕會自動清理背景 daemon。其他同容器已安裝的 Claude Code、Codex、Pi 會被偵測；缺少或未登入的 provider 不宣稱能對話。

狀態與診斷不等同真正模型回覆；對話驗收會使用帳號額度，完成後歸檔此次測試 agent、保留紀錄。配對 URL 只在受保護設定頁傳遞，API 使用 no-store/no-referrer。

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
npm audit --omit=dev --prefix runtime
```

[維運與可重複驗收](docs/operations.zh-TW.md) 包含有上限的真實並行測試工具，以及已實測的插件備份還原範圍。部署及實測結果會記錄於 docs/validation.md。各平台的登入與額度會變化，必須以新的首輪及續聊驗證為準。

## 官方介面

- [Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)
- [Paseo Hermes ACP](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)

MIT；Paseo runtime 隔離、程序擁有權及狀態鎖實作沿用 WOOWTECH Pi Paseo plugin 0.1.3，見 NOTICE.md。
