# Hermes Paseo：下載、安裝、部署與測試

適用於 v0.1.4-rc.4 公開候選版。本教學將插件部署到已有的 Hermes Agent / Dashboard；Hermes 核心與可用的模型端點須先準備好。實測範圍與待驗項目見 [驗收紀錄](validation.md)。

## 下載網址

- 原始碼：https://github.com/WOOWTECH/hermes-paseo-plugin
- Gitea 原始碼鏡像：https://git-prod.woowtech.io/mirror/hermes-paseo-plugin
- v0.1.4-rc.4：https://github.com/WOOWTECH/hermes-paseo-plugin/releases/tag/v0.1.4-rc.4
- 固定版本 ZIP：https://github.com/WOOWTECH/hermes-paseo-plugin/archive/refs/tags/v0.1.4-rc.4.zip
- Paseo 官方介面：https://app.paseo.sh

公開下載不需要 GitHub token。Web / CLI 從 GitHub 安裝會取得目前 main；ZIP 固定為 v0.1.4-rc.4。候選版不代表已完成所有正式部署環境的驗收。

## 1. 確認環境

需要 Linux、Python 3.11+、Node.js 22.19.0+、npm、util-linux 的 flock，以及支援原生 plugins、Dashboard plugins 和 ACP 的 Hermes。Hermes 的 ACP extra 與模型登入需已完成。支援範圍為單一 Hermes profile。

在 Hermes 的服務帳戶及相同 profile 環境執行：

```bash
hermes --version
python3 --version
node --version
npm --version
command -v flock
hermes acp --help
```

缺少 ACP 或模型登入時，先依 Hermes 的官方安裝／模型設定完成，再安裝此插件。Paseo runtime 會由插件下載；插件不替換 Hermes 核心、Python 環境或既有模型登入。

### Home Assistant add-on

1. 在 Home Assistant 的附加元件商店加入 `https://github.com/WOOWTECH/Woow_HA_App_Store`，安裝或更新 **Woow Hermes Agent 0.1.11**。目前支援 amd64；此映像不支援 ARM／Pi 5。
2. 從 HA 側欄操作時，在附加元件設定填入 `paseo_ingress_url`，例如 `https://ha.example.com`。填瀏覽器實際使用的協定、主機與選用 port，不含 `/api/hassio_ingress/…` 或其他路徑。保留 `public_url` 供區網 Dashboard 與 MCP OAuth 使用。
3. 保存附加元件選項後重啟這個附加元件一次。這是載入主機環境設定；日後安裝／更新插件可在 Dashboard 內重載。
4. 從 HA 側欄登入 Hermes，依下一節在 **Plugins** 安裝 `WOOWTECH/hermes-paseo-plugin` 並啟用。0.1.11 已包含主機介面，不必另外執行 Kubernetes 安裝腳本。
5. 啟用後開啟 **Paseo**，等待自動下載 runtime；若提示後端未載入，按 **重載 Dashboard → 確認重載**。接著產生配對連結，親自開啟官方 Paseo 並按 **Connect**。
6. 模型帳號在 Hermes 的 **Keys／Models** 設定；選擇模型及模式後驗收首輪與續聊。插件不附送模型額度。附件讀取還需要管理者開啟 Hermes 原生 `file` 工具集。

完整附加元件教學：[HA Hermes DOCS](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/blob/main/hermes/DOCS.md#paseo-remote-plugin-ha-ingress)。正式映像與實機測試範圍見 [HA 驗收紀錄](ha-acceptance-20261026.zh-TW.md)。

### 設定 ChatGPT／Codex 訂閱模型（Hermes 0.22.5）

1. 在目標 Hermes 開啟 **Keys**（`/env#section-oauth`），等待供應者清單載入。
2. 在 **Provider Logins (OAuth)** 找到 **ChatGPT or Codex Subscription**，按 **Login**。
3. 依畫面顯示的網址及一次性代碼，由帳號持有人完成瀏覽器授權；完成後確認該列顯示已連線。裝置碼登入的帳號前提見 [OpenAI 登入說明](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)。
4. 到 **Models → Main Model → Change**，選取該供應者及帳號實際可用的模型，按 **Switch**。只登入成功不等於原本的本機預設模型已切換。
5. 完成進行中的對話後，在 Paseo 插件頁 **停止服務 → 恢復服務**，讓新的 ACP 程序讀取設定；接著依第 5、6 節選模型並實際驗收。

這是目標 Hermes 自己的模型登入；更換用來操作本開發對話的 ChatGPT／Codex 帳號，不會自動完成此設定。無須把密碼、一次性代碼、token 或登入快取交給插件。若之後改用雲端模型，可在 Hermes 原生本機模型介面停止閒置引擎以釋放記憶體，保留已下載模型；確認其他工作沒有使用該引擎後再操作。

## 2. 安裝：Web 方式（建議）

1. 正常登入 Hermes Web，進入 **Plugins**。
2. 找到 **Install from GitHub / Git URL**。
3. 在 **Git URL or owner/repo** 輸入 `WOOWTECH/hermes-paseo-plugin`。
4. 新安裝時，開啟 **Enable after install**，按 **Install**。
5. 確認 `hermes-paseo` 卡片顯示 `enabled`；若未啟用，按 **Enable**。
6. Hermes 0.19 需重新整理頁面一次，才會載入剛安裝／啟用的插件。
7. 若 Paseo 頁顯示後端 API 尚未載入或 404，在 Paseo 頁按 **重載 Dashboard → 確認重載**。準備好的主機會等待後端重新啟動及插件 API 恢復，再自動重新整理目前頁面。
8. 如果重載按鈕無法使用，表示主機尚未安裝重載介面；管理者需先完成一次性 [主機設定](dashboard-control.zh-TW.md)。這個設定屬於主機部署，不會由普通插件 API 自行提升權限安裝。

Hermes 0.22 的首次安裝也可能因 caution 掃描結果而拒絕安裝。本候選版包含執行 Paseo 所需的子程序呼叫與程序身分檢查；核對來源為 `WOOWTECH/hermes-paseo-plugin` 並閱讀提示後，可勾選 **Force reinstall (delete existing folder first)**，再按 Install。這個選項會替換插件來源資料夾；已安裝者請先停止 Paseo。profile 的 `plugin-data/hermes-paseo/` 保留。

已從 GitHub 安裝時，使用該插件卡片的 **Git pull** 更新；更新 Python 後端後同樣需重載舊版 Dashboard。已部署的主機可直接從第 5 節開始測試。

Hermes 0.22 可能在 Git pull 後先回報掃描提示，再要求確認是否套用更新。請核對 repo 與欲安裝的版本，閱讀原生視窗列出的項目後再確認。本插件為啟動 Paseo、執行背景驗收與核對程序擁有權，包含子程序呼叫及 `/proc` 讀取，可能被標示為 caution。取消確認時程式碼不會更新；HTTP 200 本身不代表已安裝新版本。更新完成後再重載 Dashboard，確認新功能與插件版本均已載入。

從較舊 Hermes 升級後，若 Git pull 顯示 `has no owned Git checkout; reinstall from its source`，先停止 Paseo 服務，再從同一官方 repo 重新安裝並勾選 **Force reinstall** 與 **Enable after install**。原生安裝器會建立新版需要的 checkout ownership 紀錄；`plugin-data/hermes-paseo/` 保留。不要自行偽造 ownership 檔案或放寬 Git 安全檢查。

Hermes 0.22 的 SDK 會自動附上 `profile=default`；0.1.4 支援這個啟動 profile 的別名，仍拒絕其他 profile 與額外 query。此版本請在 `default` profile 使用。

## 3. 安裝：CLI 或 ZIP 方式

CLI 與 Web 安裝擇一。在 Hermes 使用的服務帳戶與 profile 中執行：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin
hermes plugins enable hermes-paseo
```

若要使用固定版本 ZIP：

1. 下載上述 v0.1.4-rc.4 ZIP 並解壓。
2. 將包含 `plugin.yaml`、`__init__.py`、`dashboard/`、`runtime/` 的那一層資料夾命名為 `hermes-paseo`。
3. 放入同一 Hermes profile 的 `plugins/` 目錄：預設為 `~/.hermes/plugins/hermes-paseo/`；自訂 `HERMES_HOME` 時為 `$HERMES_HOME/plugins/hermes-paseo/`。檔案須由 Hermes 服務帳戶擁有。
4. 確認 `plugin.yaml` 直接位於該目錄，然後執行 `hermes plugins enable hermes-paseo`。
5. 依前節完成 Dashboard 重載及頁面重新整理。ZIP 安裝不含 `.git`，更新時需下載新版本再替換插件來源資料夾；保留 profile 的 `plugin-data/hermes-paseo/`。

## 4. 容器與反向代理部署

CLI 指令與設定 Origin 的指令都須在實際 Hermes 容器內，以服務帳戶和相同 `HERMES_HOME` 執行。

支援內建重載介面的主機可直接使用插件頁的 **重載 Dashboard**。其他主機由管理者依下列方式處理一次。

使用 s6、且 Dashboard 服務位於 `/run/service/dashboard` 的映像，可由容器管理者在容器終端重載：

```bash
/command/s6-svc -r /run/service/dashboard
```

其他部署方式使用原有的程序管理方式重啟 Dashboard。只需載入插件 API，不需要更換 Hermes 映像。

若 HTTPS 入口經 HTTP 代理後遺失外部協定或 Host，為此 profile 設定精確正式 Origin：

```bash
python3 ~/.hermes/plugins/hermes-paseo/bin/configure-origin.py https://hermes.example.com
```

請把網址改成自己的 Hermes 網域；只包含協定、主機與必要的埠號，沒有結尾斜線、路徑、query 或帳密。自訂 `HERMES_HOME` 時改用該 profile 的插件路徑，例如 `python3 /opt/data/plugins/hermes-paseo/bin/configure-origin.py https://hermes.example.com`。

設定存放於私有的 `plugin-data/hermes-paseo/dashboard-origin.json`。插件仍拒絕不同 Origin 及 cross-site Fetch Metadata，不依靠客戶端任意 Forwarded 標頭取得信任。

## 5. 從 Hermes 配對到 Paseo

1. 開啟 Hermes 側欄的 **Paseo**，或自己的 Hermes 網址加 `/paseo`。尚未完成設定時，插件載入後會自動導向此頁。
2. 等待 **服務已就緒**。第一次會下載並啟動固定 Paseo runtime；已手動停止時，按 **恢復服務**。
3. 按 **產生配對連結**。
4. 按 **開啟 Paseo 官方網站並綁定**，在新分頁按 **Connect**。
5. 在 Paseo 按 **New workspace**，開啟 **Select model**。若先看到供應者清單，按 **Hermes** 再選模型；第一次測試使用 **Default** 權限模式。

Hermes 頁面的模型／模式選單用於探索可用選項；實際對話設定在 Paseo 建立對話時選擇。官方 relay 不需要額外的 Paseo 密碼。配對連結可能授予存取權，請保留給自己的裝置使用。

在 Hermes 修改預設模型後，既有 ACP 程序可能仍保留舊預設。先完成或停止進行中的對話，再在 Paseo 插件頁「停止服務 → 恢復服務」，重新取得模型清單。官方 Paseo 的模型按鈕位於訊息輸入區，文字可能是「Select model」或已選模型的名稱；選定模型後才顯示權限模式按鈕。不要把「模型清單可讀取」當作帳號已登入或模型已回覆的證據。

可依 Hermes 官方流程使用本機模型，無需雲端 API Key；仍須符合映像所要求的 context 及 CPU／記憶體限制。部分 Woow 映像要求至少 64K context，低於門檻會在呼叫模型前被拒絕；應選用符合門檻的模型及真實服務視窗。

此插件的文字對話服務預設不啟用語音模型下載；既有明確的語音啟用設定會保留。要使用 dictation／voice mode，請另行配置 Paseo 語音服務、解壓工具及模型空間，並完成語音驗收。文字配對及對話測試不包含語音功能。

若其他插件的引導視窗擋住操作，可使用該視窗的「稍後設定」，再進入 Paseo。

## 6. 測試功能

在 Paseo 送出：

```text
請記住 WOOW_TEST_001。不要使用工具或修改檔案，只回覆 WOOW_TEST_001。
```

收到回覆後再送出：

```text
我剛才讓你記住以 WOOW_TEST_ 開頭的完整代碼是什麼？只回覆完整代碼，不要使用工具。
```

兩輪都回覆 `WOOW_TEST_001`，才算完成首輪與記憶續聊測試。也可在 Hermes 插件頁按 **執行真實對話驗收（會消耗帳號額度）**，檢查結果；此按鈕使用後端代理的預設設定，不使用探索選單的選擇。

0.1.4 的驗收會立即建立背景工作，頁面顯示「驗收進行中，等待結果…」並輪詢結果。可重新整理、關閉頁面或重載 Dashboard 後回來查看；同一 profile 進行中的工作會被沿用，不會因重複點擊或重新整理再開一次模型呼叫。只有結果確認首輪、續聊及測試代理清理均成功，才顯示通過。容器被終止時，未完成的工作會標示中斷；不會自動重新送出可能產生費用的請求。

驗收會使用真實模型帳號額度。自動驗收完成後歸檔此次建立的測試代理及專用工作區，保留歷史。歸檔未確認時不會回報驗收通過；手動建立的測試對話由使用者在 Paseo 歸檔。

要在 Hermes 對話使用原生工具，若 profile 限定工具集，將 `hermes_paseo` 納入需要使用的工具集；單次 CLI 測試可用：

```bash
hermes chat --toolsets hermes_paseo --query "請用 paseo_status 查看連線狀態"
```

Hermes 的 Tool Search 會透過 `tool_search`／`tool_describe`／`tool_call` 間接調用插件工具。專用的小模型測試 profile 若只有少量工具，可在 Hermes 設定使用 `tools.tool_search.enabled: off`，直接載入工具 schema。這是測試 profile 的明確設定，插件安裝及更新不會代為更動；工具很多的環境應依模型能力與 context 預算保留原設定。設定方式見 [Hermes Tool Search 官方說明](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)。在專用測試 profile 使用 CLI 時可執行：

```bash
hermes config set tools.tool_search.enabled off
```

`off` 是設定值，不要把額外的雙引號字元存進值內。實測曾因值變成包含引號的字串而未關閉 Tool Search，導致小模型反覆搜尋工具、未完成對話。設定後完成或停止進行中的對話，再從 Paseo 頁停止／恢復服務，讓新的 ACP 程序載入。

### 小模型測試的 ACP 工具範圍

Hermes 0.22.5 會自動加入尚未在該平台記錄過的插件工具。只填 `platform_toolsets.acp: [hermes_paseo]`，仍可能載入其他插件。本次冷啟動實測因此出現小模型調用不相關工具、沒有回覆測試代碼的失敗。

早期小模型測試使用同版 Hermes 工具選單的保存函式，記錄 ACP 選擇及當時已知的插件工具集，再以 Hermes 的實際解析結果確認只有 `hermes_paseo`。當時的相關片段如下；插件名稱是此服務的實測清單，其他主機須依自己的已安裝工具集處理：

```yaml
platform_toolsets:
  acp: [hermes_paseo]
known_plugin_toolsets:
  acp: [a2a, hermes_paseo, omnigent]
```

這版 CLI 的 `hermes tools disable omnigent --platform acp` 會顯示 `Unknown platform 'acp'`，卻回傳退出碼 0；不能用它的退出碼判定成功。管理者應備份設定、使用與該 Hermes 版本相容的工具配置介面，並驗證實際載入的工具及真實對話。保存程序涉及 Hermes 內部介面，升級版本時須重驗。此服務僅限制 ACP，一般 CLI 工具保留；日後安裝新插件仍可能擴充實際工具範圍，需要重新檢查。此配置是小模型測試範圍，並非權限隔離或安全沙箱。

### 更換自訂供應商金鑰後

請使用 Hermes 原生自訂 Endpoint 設定保存金鑰，讓 `providers` 透過 `key_env` 引用 `.env`。不要直接覆寫舊對話使用的 inline `custom_providers.api_key`：HA 實測中，舊對話會保留舊憑證，重啟後可能回報 `launch_credentials_unavailable`，Paseo 也可能將同一錯誤顯示為不支援模型選擇。

既有 inline provider 的遷移方式是先保留舊宣告、建立新的命名供應商，再在原對話明確選取新供應商／模型。確認切換與實際續聊成功後，才移除舊宣告並撤銷舊憑證。HA 已實測新命名供應商的模型切換與重啟保留；後續 DeepSeek 真實回覆為提示被攔截，記憶續聊未通過。rc.4 將這段精確回覆分類為 `PROVIDER_PROMPT_BLOCKED`，不再誤報完成。不要連續重送失敗訊息，詳見 [HA 驗收紀錄](ha-acceptance-20261026.zh-TW.md)。

### Paseo Web 實測注意事項

2026-10-26 以官方 Web 0.13.0、daemon 0.11.2、Hermes 0.22.5 實測；詳見 [Web 測試矩陣](web-acceptance-20261026.zh-TW.md)。Web 會提示主機版本較舊，不能把文字對話通過推論為所有新功能皆相容。

- **重新整理／重連**：歷史與輸入框可能先於連線完成出現。如果送出時顯示 `Host is not connected` 或 `Transport not connected`，先保留草稿，至 Settings → 該主機 → Overview 確認 Online，再返回對話送出。實測未連線時送出會保留草稿，需要重送；不要連續點擊。
- **附件**：上傳完成不等於模型已讀取。此版 daemon 將一般檔案的名稱、路徑、MIME 與大小交給 ACP，沒有直接嵌入檔案內容。上述小模型設定只開 `hermes_paseo`，缺少 `read_file`，因此文字附件讀取實測失敗。Hermes 原生 `file` 工具集包含 `read_file`、`write_file`、`patch`、`search_files`，會擴大模型可用能力；須由管理者核准後以相容介面設定並在新對話重驗。插件不自動擴權。檔案工具受服務帳戶的檔案權限約束，不能假定僅能存取當前工作區。測試站在使用者明確核准後已套用 `[file, hermes_paseo]`，確認 CLI／其他配置不變，並通過新 ACP 實例的工具載入與原生讀寫測試；模型附件回覆仍待額度恢復後重測。
- **移除未送出的附件**：桌面版先將滑鼠移到附件卡片，再點移除按鈕。直接點隱藏狀態的移除控制，可能被卡片遮擋。
- **歸檔／還原**：在側欄工作區選單選 Archive。從 History 找回後，先按工作區的 Unarchive；若對話仍顯示 `This agent is archived`，再按對話內的 Unarchive。工作區與 agent 是分開還原的。
- **額度不足**：本次後段實測收到訂閱供應商 HTTP 429，最後還伴隨 `Internal error: admitted_turn_failed`。應讀取前面的供應商訊息判斷原因，等待帳號額度恢復再重試。重新配對或重啟 daemon 不會恢復供應商額度。

## 7. 停止、恢復及移除

在 Paseo 插件頁按 **停止服務**，確認停止後重新整理；服務應保持停止。再按 **恢復服務**，確認回到就緒。這個操作保留配對設定與對話資料。

配置 0.1.4 主機介面時，Hermes Web 的 Disable／移除會先停止 daemon，確認後才執行原生操作。Hermes 0.22 的移除可能顯示為垃圾桶圖示，按下後須在確認視窗按 Delete。重新安裝同一 repo 並開啟 Enable after install，會沿用 plugin-data 中的配對及安裝識別。

沒有主機介面、或使用 CLI 停用／移除時，先用插件頁或 `/paseo stop` 停止 daemon，確認 `/paseo status` 的 `daemon.running=false`，再停用／移除。Hermes 0.19 沒有插件卸載 callback。

Hermes 0.19 的首次引導為插件頁配對精靈；此版沒有公開的新建原生聊天 API，因此不宣稱啟用後會自動建立新的原生 Hermes 聊天。

## 常見問題

| 現象 | 處理方式 |
| --- | --- |
| 啟用後側欄沒有 Paseo | Hermes 0.19 重新整理頁面一次。 |
| 插件 API 404／尚未載入 | 在插件頁按「重載 Dashboard」並確認；主機需先配置重載介面。 |
| Restart Gateway 顯示已啟動但未完成 | 查看工作最終狀態；若為 `no dependency environment is committed`，須由管理者處理官方 PM 環境及修復所需空間，詳見 [主機說明](dashboard-control.zh-TW.md)。 |
| 403／Origin 被拒絕 | 確認插件已啟用及登入有效；使用服務帳戶設定精確正式 Origin。 |
| 沒有模型或無法回覆 | 確認 Hermes ACP 已安裝，並完成 Hermes 官方模型登入／設定。 |
| `PROVIDER_PROMPT_BLOCKED` | 已收到提示被攔截的回覆，未取得有效答案。查看供應商與主機日誌；不要把 idle 當成成功，也不要自動重送。 |
| `PROVIDER_TURN_FAILED` | 到 Hermes 的 Logs 檢查該次錯誤；可能是模型登入、context 不足或推理服務失敗。修正後重新執行首輪／續聊，不能僅依 ready 狀態判定成功。 |
| 切換預設模型後仍出現舊模型 | 完成進行中的對話後，停止並恢復 Paseo 服務，讓 ACP 重新載入。 |
| 沒有 Claude Code、Codex 或 Pi | 需先在同容器安裝與完成各官方登入，才會被插件偵測。 |
| Hermes 對話找不到插件工具 | 檢查 profile 的工具集白名單是否包含 `hermes_paseo`。 |

參考：[Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)、[Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)、[本插件說明](../README.md)。
