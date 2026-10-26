# HA Hermes × Paseo：2026-10-26 實機驗收

HA add-on **0.1.11** 已發布，HA App Store 已同步。公開插件 **v0.1.4-rc.4** 延續 rc.3 的 HA Ingress 支援，並將本次觀察到的提示攔截回覆回報為錯誤；Gitea 為公開原始碼鏡像。本輪已補完 HA 核心文字對話、兩模型切換、正式商店新裝及原生備份還原驗收，八輪真實對話全部通過。以下保留早前失敗與目前支援範圍，不把其他環境的待驗項目視為通過。

## 版本與發布來源

- [HA PR #9](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/pull/9)，發布 commit `7cb73f5390da8b1f4c31a97eec53131737cfd0ed`。
- [穩定版 v0.1.11](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/releases/tag/v0.1.11)。[映像發布 CI](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/actions/runs/40293002590) 與 [Release train](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/actions/runs/40293001872) 通過。
- [來源通知 CI](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/actions/runs/40293582290) 與 [App Store 同步 CI](https://github.com/WOOWTECH/Woow_HA_App_Store/actions/runs/40293629698) 通過。Store commit `8395693ff68fae9b360182c734c2263966572ee5` 的設定、目錄版本、來源 commit 及映像 digest 與來源通知相符，並包含 `paseo_ingress_url` 選項。
- 映像：`ghcr.io/woowtech/woow-ha-hermes-amd64:0.1.11`。amd64 manifest：`sha256:1b14ab1a9f2440be549864c5d1562758cd4dbb660f195142ca5b6aac2a69aa7e`；匿名讀取 registry manifest 成功。
- [GitHub 插件](https://github.com/WOOWTECH/hermes-paseo-plugin)、[Gitea 公開鏡像](https://git-prod.woowtech.io/mirror/hermes-paseo-plugin)。插件功能測試 commit `ffc9ade6f316745b1850b329ccd7c6b88ce4bd71`，rc.3 標籤為 `88ffa70e3ae5b3bb7a1ad8a92558f6d1d54ff90a`。

## 實機環境與方法

新建隔離的 HAOS 18.3／Core 2026.10.4 虛擬機，amd64、2 vCPU、8 GiB RAM、64 GiB 磁碟，依正常 onboarding 建立測試管理者。未使用既有共用 HA 主機。以 Chromium 操作 HA 側欄 iframe、Hermes 原生 Plugins 與官方 `app.paseo.sh`。

第一輪使用 0.1.10 加入此次變更的候選層；完整候選映像另外通過 CI。發布後，由正常 Supervisor update（要求附加元件備份）升至固定 digest 的正式 0.1.11 檔案層。測試包只調整本機測試版本的 `ENV`，沒有覆蓋或新增程式檔案；逐項核對 rootfs layers、啟動設定、六個整合檔案雜湊、私有選項、持久化掛載、插件檔案與設定保留，10 項全部通過。

## 已完成測試

| 項目 | 實際結果 |
| --- | --- |
| 原生 Web 安裝 | 在 Plugins 從公開 GitHub 安裝並啟用；自動進入 `/paseo`，下載 runtime 並啟動 daemon。 |
| 原生 HA 商店 | 在新 HAOS 加入官方商店，實際下載並安裝 0.1.11／amd64（`build: false`），下載映像 digest 與公開發佈相符。後續已啟動此正式商店實例，完成全新安裝／配對、首輪、附件及加密備份還原後續聊，見下方續測。 |
| HA 側欄 | 從真正 HA 側欄點擊進入 iframe，插件 API 200；正式映像升級後再次通過。 |
| 官方配對 | 從插件產生配對連結，點擊開啟官方 Paseo 並 Connect；新裝置完成配對，已儲存裝置能重連。 |
| Dashboard 內重載 | 點擊重載並確認，後端 generation 改變、Ingress 前綴保留、API 與配對按鈕恢復；正式映像再次通過。 |
| 停止與恢復 | UI 停止後重新整理仍保持停止；明確恢復後重新可連線。 |
| Gitea 直接安裝／移除 | 原生 Plugins 移除後，以公開 Gitea clone URL 安裝並啟用成功；相同配對、資料與對話歷史保留，來源 commit 相符。 |
| 原生停用／啟用 | 已補測運行中 daemon：Plugins Disable 確實停止程序，Enable 後重新可連線。 |
| 附加元件重啟 | Supervisor restart 後插件、原配對及相同對話／附件歷史保留。 |
| 來源與登入限制 | Ingress／LAN 共 16 組真實 HTTP 檢查通過：正確登入與來源可讀取、外站來源 403、未登入 401，沒有對外站開放 CORS。 |
| 插件真實驗收 | 按插件頁驗收按鈕一次，首輪與記憶續聊皆通過，測試 agent／workspace 歸檔成功。 |
| 官方 Web 模型與模式 | 清單顯示兩個已設定模型，Default／Accept Edits／Don't Ask 三種模式可見；用預設 Xiaomi 與 Default 建立實際對話。原對話在早前一次 DeepSeek 續聊收到攔截文字；後續本輪新舊對話、兩模型切換及冷啟動續聊均通過，失敗歷史保留。 |
| 官方 Web 附件 | 從 UI 上傳含隨機碼的文字檔，模型回覆正確檔案內容；以後端 assistant timeline 核對，沒有把使用者輸入當成模型回覆。 |

## 歷史：換金鑰後的失敗與 rc.4 修正

正式映像升級後，原配對及對話／附件歷史可讀取。原兩小時測試金鑰在開發工作中斷期間到期，後續已撤銷並換成相同限制的新金鑰。首次舊對話續聊得到 HTTP 401，仍送出已撤銷的舊金鑰。完整附加元件重啟後的第二次嘗試回報 `admitted_turn_failed`；gateway 日誌進一步確認為 `launch_credentials_unavailable`。兩者是不同失敗，不能都記為 401，也不能僅憑畫面宣稱未執行任何工作。當時替換的金鑰在 10:38 UTC 查核費用仍為零。

原生模型切換控制重現了根因：`custom_providers.0.api_key` 與該 session 建立時的設定不同。Hermes 有回傳兩個模型；Paseo 將這次底層例外轉成 `acp does not expose ACP model selection`，因此該訊息不代表 Hermes 沒有模型清單。單純更新 profile 或重啟無法替固定 session policy 更新原 inline 金鑰。

在隔離 QA 透過 Dashboard 原生自訂 endpoint API 建立使用 `key_env`／`.env` 的新命名供應商，保留舊宣告供原生 session 明確遷移。從官方 Paseo Web 選取新供應商的 DeepSeek 後，對話儲存的 model 與 runtime model 皆更新成功。隨後設為預設並移除舊供應商宣告；原金鑰始終保持撤銷，沒有重新啟用。整個附加元件重啟後，原配對 Online、原對話與附件歷史、新模型選擇均保留；再呼叫原生模型變更控制也未出現憑證恢復錯誤。以上設定／模型控制均未提交推論訊息，也未修改 session 資料庫或上游程式。

已完成官方 Web 的歸檔與還原操作。取得單輪明確授權後，因前一把短效金鑰已過期且費用為零，撤銷它並建立相同兩模型、兩小時、US$0.02 限制的替代金鑰，更新原生 `.env` 引用，再次重啟確認原對話與模型保留。

2026-10-26 **12:23:51 UTC** 從官方 Paseo Web 送出一次記憶續聊。依精確測試金鑰查詢 LiteLLM 用量日誌，只有 **1 次** `openrouter/deepseek/deepseek-v4-flash-0731` 請求；API 記錄為 `success`，輸入 4,530 tokens、輸出 **13 tokens**，費用 **US$0.000542164**（上限 US$0.02；輸出設定上限 512 tokens）。後端新增的 assistant 回覆為：

> The tool call did not complete because the prompt was blocked.

原生 session 的最後一輪是 user → assistant，沒有新工具呼叫；僅原測試代理仍存在且為 idle，未新增子代理。該回覆沒有原始記憶碼，**當時正式映像上的換金鑰記憶續聊／第二模型回覆驗收未通過**。API 的成功狀態與費用不能替代內容驗證。未自動重送；測試金鑰已撤銷，歷史保留。前面候選環境的四輪成功回覆及附件驗收仍有效。上游具體攔截原因未取得確證。

此次亦重現插件的錯誤判斷缺口：`paseo_chat`／`paseo_continue` 會把 idle 加這段精確回覆視為 completed。rc.4 新增 `PROVIDER_PROMPT_BLOCKED`，回傳 `status: error`；一般回答引用或討論這段文字不會被誤判。回歸測試先重現兩個失敗，再於修補後通過；完整 Node 測試 **86/86**、Python **81/81** 通過。這項修補防止誤報成功，上游攔截原因仍待查核。

新部署請使用 Hermes 原生自訂 Endpoint 的憑證設定，避免把輪替金鑰寫成會被既有對話固定的 inline `custom_providers.api_key`。需遷移既有 inline provider 時，應先保留舊宣告、建立新命名供應商、明確切換對話，完成驗證後再移除舊宣告與撤銷舊憑證。直接覆寫舊金鑰的相容性問題仍存在；本次不宣稱已修補上游。

## 續測完成：兩模型、正式商店成品及備份還原

2026-10-26 **14:20–15:05 UTC**，重新取得繼續實測的指示後，使用另一把兩小時、同兩模型、US$0.02 上限的短效金鑰，透過原生命名 Endpoint 更新 `key_env`，保留原對話。以下八輪都從官方 Paseo Web 操作，以新的 assistant 時間軸訊息逐字核對；續聊題目不提供答案。

| 案例 | 結果 |
| --- | --- |
| 全新 DeepSeek 首輪 | 正確回覆新的隨機碼。 |
| 同一 DeepSeek 對話續聊 | 記住第一輪隨機碼。 |
| 先前失敗的原對話續聊 | 同一原始歷史、新金鑰及 DeepSeek，正確回覆原始記憶碼；沒有刪改失敗歷史。 |
| DeepSeek → Xiaomi 切換 | 官方 UI 切換後，第二模型正確回覆前文記憶碼。 |
| 歸檔、還原、附加元件冷啟動後續聊 | 原配對 Online，歷史與模型保留，Xiaomi 再次正確回覆記憶碼。 |
| 官方商店 0.1.11 全新實例首輪 | 正常商店成品啟動、原生 Plugins 安裝、全新裝置配對、新增 project 後，DeepSeek 正確回覆隨機碼。 |
| 官方商店成品附件 | UI 上傳文字檔；原生 session 確認真正呼叫 `read_file`，assistant 回覆只存在檔內的隨機碼。 |
| 原生加密備份還原後續聊 | 同一配對與對話，DeepSeek 正確回覆第一輪記憶碼，而非附件碼。 |

正式商店實例由 Supervisor 安裝的原始 **0.1.11** 映像啟動，未調整測試版本 ENV；僅使用 HA Ingress，三個 host port 均關閉。其插件從公開 GitHub 原生安裝，實際 commit `76b6dff9ec798cc5ca6085afa39afd8abcc522b8`，版本 rc.4；與 rc.4 tag 的執行程式相同，後續差異為測試與文件。

### 首次使用流程補齊

全新實例在不勾 Force 時，原生插件安全掃描回傳 HTTP 400，要求確認 caution；17 項命中逐項核對為程序啟動、程序身分核對、獨立部署工具、測試案例及輸入驗證。依既有安裝教學使用原生單次 **Force reinstall** 後安裝成功，沒有停用全域掃描。已將確認條件移入安裝步驟。

全新 Paseo 裝置會顯示 **No projects yet／Choose project**。首次 Create 操作未建立代理，精確金鑰用量也沒有新增請求；它不是一次失敗的模型推論。從官方 **Add project → New directory → Use this parent** 在持久化目錄建立專案後，再完成草稿，首輪成功。安裝文件已補上 project 前置步驟；配對 Online 及模型清單可讀取不能取代這一步。

### 還原與短時間穩定性

使用 [Supervisor 原生部分備份／還原](https://contributors.home-assistant.io/apps/supervisor-api/backups/)建立約 **285.9 MB** 的加密備份，只包含這個官方商店附加元件，不包含 HA Core 或其他目錄。備份後改寫專用測試標記，再只還原該附加元件；標記回到備份時內容，設定、`.env` 及插件來源雜湊一致，原裝置重連且對話與附件歷史保留。重載會重建時間軸傳輸欄位並去除尾端空白，因此以訊息順序與正規化後的助手文字核對；再以真正記憶續聊證明可用。測試標記已清理，備份及密碼只保存在私有測試環境。

正式商店實例的唯讀狀態 API 完成 **60 次、4 路並行**，60/60 HTTP 200 且 reachable；p50 **148.60 ms**、p95 **1,556.60 ms**、最大 **1,926.90 ms**，觀測 **7.85 秒**，OOM／OOM kill 均為零。另一測試實例在包含商店備份還原作業的 **607.2 秒**觀測中，21/21 次狀態檢查均成功，沒有 OOM。這些是本環境單次短測，不代表長期容量或 SLA。

### 費用、收尾與尚未確診項目

本輪 **8 次有模型的使用者輪次、11 筆供應商請求**，費用 **US$0.0021995292**；輸出上限 512 tokens、金鑰預算 US$0.02。另有一次缺 project 的 UI Create 點擊未提交到模型，原紀錄保留，沒有將其算成推論成功或重送已執行的模型回合。金鑰已於 **15:05 UTC 撤銷**，日誌費用與金鑰計數一致；撤銷後瀏覽器引發兩筆 `/models`／`/v1/models` 讀取失敗，均為零 tokens、零費用，不是新增推論；本輪兩個新測試工作區已從 UI 歸檔，歷史保留，原始換金鑰測試對話保留。

先前 12:23 的攔截回覆仍保留為歷史失敗。該請求的代理服務紀錄未記錄 guardrail、retry 或 fallback；未取得原始上游 finish reason，不能由後續成功斷言攔截根因已修復。本輪原對話成功，表示換金鑰後的記憶續聊功能已取得通過證據。直接覆寫 inline provider 金鑰的上游相容性問題仍依前述遷移方式處理。

可核對的去識別化結果：[本輪驗收資料](https://github.com/WOOWTECH/hermes-paseo-plugin/blob/main/docs/evidence/20261026-ha-continuation.json)。此次不更換 runtime、HA 映像或 plugin release；修正的是首次使用教學及驗收結論。

## 安裝

在 HA 附加元件商店加入 `https://github.com/WOOWTECH/Woow_HA_App_Store`，安裝／更新 Woow Hermes Agent 0.1.11。在附加元件設定填入瀏覽器的 HA 來源 `paseo_ingress_url`（只含協定、主機與選用 port），保留原本的 `public_url`，保存後重啟附加元件一次。接著在 Hermes Plugins 安裝 `WOOWTECH/hermes-paseo-plugin`，或完整 Gitea clone URL，啟用後依 Paseo 頁配對。

詳細選項見 [HA DOCS](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/blob/main/hermes/DOCS.md#paseo-remote-plugin-ha-ingress)。此附加元件目前只支援 **amd64**，不是 Pi 5／ARM 映像。

## 範圍與保留事項

- 插件仍為 rc.4 公開預覽；HA add-on 的穩定版標記不代表所有上游 Paseo Web 新功能、其他供應商或其他主機均已驗收。原 PaaS 訂閱模型的 HTTP 429 紀錄仍保留；這次使用隔離 HA 的模型測試，不宣稱已替原 PaaS 重測。
- 模型使用獨立、短效、限兩個模型且單次金鑰預算 $0.02 的測試金鑰。每個請求輸出上限 512 tokens；獨立 ACP 建構檢查確認一般應用最多嘗試一次、SDK 重試零次及恢復 ladder 零次；該檢查未覆蓋所有原生 gateway policy 路徑。上游仍有獨立的傳輸修復與截斷續傳邏輯，因此明確送出的使用者輪數不等於供應商請求數。
- 附件讀取需要管理者另外啟用原生 `file` 工具；測試僅為 ACP 啟用 `file` 與 `hermes_paseo`。插件本身不擴大工具權限。模型帳號須由安裝者自行設定。
- 部分原生 401／403 錯誤回應缺少隱私／安全 header；本次拒絕行為通過，不宣稱所有回應 header 完整。16 組矩陣為帶明確 Origin 的唯讀 API 檢查，並非瀏覽器 preflight 或所有寫入路由的完整安全稽核。
- Gitea 為每 8 小時拉取的 Git 鏡像；手動同步與匿名 refs 核對已測。未等待完整排程週期；GitHub Release 說明／附件與容器映像不由 Git 鏡像複製。
- 長期壓力、整機災難復原及未安裝的 Claude Code／Codex／Pi provider，不在此 HA 驗收範圍。未公開配對連結、管理者密碼、金鑰、對話內容或私有測試端點。
