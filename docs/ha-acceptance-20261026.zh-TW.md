# HA Hermes × Paseo：2026-10-26 實機驗收

HA add-on **0.1.11** 已發布，HA App Store 已同步。公開插件 **v0.1.4-rc.3** 提供 HA Ingress 第二來源支援；Gitea 為公開原始碼鏡像。以下只說明這次 HA 環境與已記錄的測試，不把其他環境的待驗項目視為通過。

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
| 原生 HA 商店 | 在新 HAOS 加入官方商店，實際下載並安裝 0.1.11／amd64（`build: false`），下載映像 digest 與公開發佈相符。此第二實例保持停止；功能驗收由前述正式檔案層實例執行。 |
| HA 側欄 | 從真正 HA 側欄點擊進入 iframe，插件 API 200；正式映像升級後再次通過。 |
| 官方配對 | 從插件產生配對連結，點擊開啟官方 Paseo 並 Connect；新裝置完成配對，已儲存裝置能重連。 |
| Dashboard 內重載 | 點擊重載並確認，後端 generation 改變、Ingress 前綴保留、API 與配對按鈕恢復；正式映像再次通過。 |
| 停止與恢復 | UI 停止後重新整理仍保持停止；明確恢復後重新可連線。 |
| Gitea 直接安裝／移除 | 原生 Plugins 移除後，以公開 Gitea clone URL 安裝並啟用成功；相同配對、資料與對話歷史保留，來源 commit 相符。 |
| 原生停用／啟用 | 已補測運行中 daemon：Plugins Disable 確實停止程序，Enable 後重新可連線。 |
| 附加元件重啟 | Supervisor restart 後插件、原配對及相同對話／附件歷史保留。 |
| 來源與登入限制 | Ingress／LAN 共 16 組真實 HTTP 檢查通過：正確登入與來源可讀取、外站來源 403、未登入 401，沒有對外站開放 CORS。 |
| 插件真實驗收 | 按插件頁驗收按鈕一次，首輪與記憶續聊皆通過，測試 agent／workspace 歸檔成功。 |
| 官方 Web 模型與模式 | 清單顯示兩個已設定模型，Default／Accept Edits／Don't Ask 三種模式可見；用預設 Xiaomi 與 Default 建立實際對話。原對話透過新命名供應商切換 DeepSeek 已通過，實際回覆待驗，見下文。 |
| 官方 Web 附件 | 從 UI 上傳含隨機碼的文字檔，模型回覆正確檔案內容；以後端 assistant timeline 核對，沒有把使用者輸入當成模型回覆。 |

## 換金鑰驗證：模型切換已恢復，實際續聊待驗

正式映像升級後，原配對及對話／附件歷史可讀取。原兩小時測試金鑰在開發工作中斷期間到期，後續已撤銷並換成相同限制的新金鑰。首次舊對話續聊得到 HTTP 401，仍送出已撤銷的舊金鑰。完整附加元件重啟後的第二次嘗試回報 `admitted_turn_failed`；gateway 日誌進一步確認為 `launch_credentials_unavailable`。兩者是不同失敗，不能都記為 401，也不能僅憑畫面宣稱未執行任何工作。新金鑰在 10:38 UTC 查核仍為零推論請求、零費用。

原生模型切換控制重現了根因：`custom_providers.0.api_key` 與該 session 建立時的設定不同。Hermes 有回傳兩個模型；Paseo 將這次底層例外轉成 `acp does not expose ACP model selection`，因此該訊息不代表 Hermes 沒有模型清單。單純更新 profile 或重啟無法替固定 session policy 更新原 inline 金鑰。

在隔離 QA 透過 Dashboard 原生自訂 endpoint API 建立使用 `key_env`／`.env` 的新命名供應商，保留舊宣告供原生 session 明確遷移。從官方 Paseo Web 選取新供應商的 DeepSeek 後，對話儲存的 model 與 runtime model 皆更新成功。隨後設為預設並移除舊供應商宣告；原金鑰始終保持撤銷，沒有重新啟用。整個附加元件重啟後，原配對 Online、原對話與附件歷史、新模型選擇均保留；再呼叫原生模型變更控制也未出現憑證恢復錯誤。以上設定／模型控制均未提交推論訊息，也未修改 session 資料庫或上游程式。

已完成官方 Web 的歸檔與還原操作。**正式映像上的換金鑰記憶續聊，以及還原後第二模型的真實回覆，仍待一輪明確授權的付費驗收**。模型選擇成功不能替代該回覆驗證。前面候選環境的四輪成功回覆、附件驗收及正式映像資料保留結果仍有效。

新部署請使用 Hermes 原生自訂 Endpoint 的憑證設定，避免把輪替金鑰寫成會被既有對話固定的 inline `custom_providers.api_key`。需遷移既有 inline provider 時，應先保留舊宣告、建立新命名供應商、明確切換對話，完成驗證後再移除舊宣告與撤銷舊憑證。直接覆寫舊金鑰的相容性問題仍存在；本次不宣稱已修補上游。

## 安裝

在 HA 附加元件商店加入 `https://github.com/WOOWTECH/Woow_HA_App_Store`，安裝／更新 Woow Hermes Agent 0.1.11。在附加元件設定填入瀏覽器的 HA 來源 `paseo_ingress_url`（只含協定、主機與選用 port），保留原本的 `public_url`，保存後重啟附加元件一次。接著在 Hermes Plugins 安裝 `WOOWTECH/hermes-paseo-plugin`，或完整 Gitea clone URL，啟用後依 Paseo 頁配對。

詳細選項見 [HA DOCS](https://github.com/WOOWTECH/Woow_ha_hermes_add_on/blob/main/hermes/DOCS.md#paseo-remote-plugin-ha-ingress)。此附加元件目前只支援 **amd64**，不是 Pi 5／ARM 映像。

## 範圍與保留事項

- 插件仍為 rc.3 公開預覽；HA add-on 的穩定版標記不代表所有上游 Paseo Web 新功能、其他供應商或其他主機均已驗收。原 PaaS 訂閱模型的 HTTP 429 紀錄仍保留；這次使用隔離 HA 的模型測試，不宣稱已替原 PaaS 重測。
- 模型使用獨立、短效、限兩個模型且單次金鑰預算 $0.02 的測試金鑰。每個請求輸出上限 512 tokens；獨立 ACP 建構檢查確認一般應用最多嘗試一次、SDK 重試零次及恢復 ladder 零次；該檢查未覆蓋所有原生 gateway policy 路徑。上游仍有獨立的傳輸修復與截斷續傳邏輯，因此明確送出的使用者輪數不等於供應商請求數。
- 附件讀取需要管理者另外啟用原生 `file` 工具；測試僅為 ACP 啟用 `file` 與 `hermes_paseo`。插件本身不擴大工具權限。模型帳號須由安裝者自行設定。
- 部分原生 401／403 錯誤回應缺少隱私／安全 header；本次拒絕行為通過，不宣稱所有回應 header 完整。16 組矩陣為帶明確 Origin 的唯讀 API 檢查，並非瀏覽器 preflight 或所有寫入路由的完整安全稽核。
- Gitea 為每 8 小時拉取的 Git 鏡像；手動同步與匿名 refs 核對已測。未等待完整排程週期；GitHub Release 說明／附件與容器映像不由 Git 鏡像複製。
- 長期壓力、整機災難復原及未安裝的 Claude Code／Codex／Pi provider，不在此 HA 驗收範圍。未公開配對連結、管理者密碼、金鑰、對話內容或私有測試端點。
