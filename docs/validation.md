# Hermes Paseo 驗收紀錄

## 最新：2026-10-26 官方 Paseo Web 詳細測試

已新增 [完整 Web 測試矩陣、問題原因與重測步驟](web-acceptance-20261026.zh-TW.md)。Web 0.13.0／daemon 0.11.2 下，新裝置配對、兩模型文字對話、三種模式實際套用、中止後續聊、雙裝置並行、手機模擬、斷線保留草稿／重送、改名、搜尋及歸檔操作通過。

**最新未完成項目：** 測試 profile 僅開 `hermes_paseo`，上傳檔案存在但模型缺少檔案工具而無法讀取；尚未核准擴充 ACP 檔案能力。還原後的續聊則遇到訂閱供應商 HTTP 429，未取得有效回覆。下方歷史對話成功紀錄保留，不代表帳號目前仍有可用額度，也不取代這兩項重測。

## 0.1.4-rc.2：2026-10-25／26 專用服務實測

**最新重測結論：雲端模型的核心連線與對話驗收已通過，完整商業上線驗收仍有待辦。** 使用者已在專用 Hermes 完成 ChatGPT／Codex 訂閱授權；以該帳號可用的 `openai-codex:gpt-6.1-sol` 重跑官方 UI、原生工具及容器重建後的真實對話，結果如下。早期 0.8B 本機模型兩次冷啟動失敗仍保留，不能將更換模型後的成功視為該本機模型已修復。

核心插件實作沿用 `5ccff6f2b64f4c0761b70be98c2a60b9695a69b7`，已經從 Hermes 原生 Plugins 頁安裝到專用測試服務；0.1.4-rc.2 新增並行驗收工具、對應測試與維運文件，未更換 daemon／主機 adapter 核心。環境為 Hermes 0.22.5、Python 3.14.9、Node 26.12.1、Linux x64、s6、單一 profile、2 CPU／6 GiB RAM；受登入保護的 HTTPS Dashboard 經反向代理存取，使用本 repo 的主機 adapter。以下是此環境的證據，不代表所有 Hermes 映像或部署模板皆適用。

### 維運驗收追加：2026-10-25

| 項目 | 本輪實測結果與邊界 |
| --- | --- |
| 並行真實對話 | 以 `openai-codex:gpt-6.1-sol` 分兩輪、每輪三路並行，六段對話共十二次模型回覆全部通過；首輪與續聊均檢查新的 assistant cursor、自己的隨機代碼及其他對話的代碼未混入。所有 agent／工作區歸檔確認，無需人工清理；SDK 測試約 80.5 秒，含外部執行程序約 81.6 秒。這是有上限的小量測試，未證明最大容量。 |
| 第二個雲端模型 | 官方 Paseo 實際選取 `openai-codex:gpt-6-luna`，首輪與未重複提供代碼的記憶續聊通過並歸檔，約 29.3 秒。這是第二個模型的抽樣，其他模型與帳號額度狀態仍須個別驗收。 |
| 十分鐘狀態觀察 | 四路同時請求、每批後間隔五秒，約 602 秒完成 404 次已登入狀態請求，零錯誤、容器零重啟、cgroup 記憶體事件未增加。HTTP 中位數約 559 ms、p95 約 3399 ms、最大約 4993 ms；期間包含真實並行與模型切換。稀疏記憶體採樣起始約 1866 MiB、結束約 1587 MiB，採樣最高約 1890 MiB；不能代表瞬間峰值或洩漏檢測。這不是長期 soak、飽和負載或 SLA 驗收。 |
| 插件資料還原 | 停止並保存暫停意圖後，將 165 個持久檔案備份至另一個私人儲存位置，再從該備份替換原資料。checksum 全部一致，安裝／伺服器／配對金鑰身分保留，Origin 為 600。原對話記憶續聊通過；官方 Paseo 使用原配對再完成兩輪，約 30.3 秒。Hermes 原生帳號、session、runtime 及模型快取保留，因此不是完整主機災難復原。 |
| 可控跨節點搬移 | 僅調整專用 StatefulSet 的暫時排程條件，讓 PVC 在另一個健康節點重新掛載。無瀏覽器約 154.8 秒恢復；原身分／配對保留，官方 UI 首輪與記憶續聊通過。還原排程條件後約 94.9 秒再次恢復，兩個容器重啟計數均為 0。未模擬斷電、網路分割或強制磁碟卸載。 |
| Helm 模板修正 | 選用式、預設停用的 chart `0.4.0` 已發布至 Gitea Helm／OCI，完整倉庫 CI 通過；17 組 Hermes 測試包含新行為回歸 55 項。另修復共用 Console checker 的埠占用問題，新增 6 項回歸。兩個 channel 重新下載套件完全相同，26 個檔案 hash 符合驗證候選。2026-10-26 已透過 PaaS `.263` 的服務專用版本固定與原生 Redeploy 部署到測試服務，實際掛載及對話驗證通過；沒有更改全租戶模板。 |

新增可重複使用的 `tests/live-concurrency.mjs`，需要明確 `--run` 與模型 ID；預設三路，最多四路、兩輪、八段對話。建立與清理無法確認時保留私人復原紀錄，不重送可能計費的請求。首次實機執行在初始化發現 Node 26 對 CommonJS `ws` 模組的匯出格式不同，尚未呼叫模型即失敗；加入相容處理與實際 CommonJS namespace 回歸後，重新通過上述並行測試。這是新驗收工具的修正；插件 daemon 核心沿用前版，舊候選版 tag 保持不變。

本輪本機 Node 回歸 84 項、Python 回歸 70 項通過。備份範圍、復原順序與並行測試命令見 [維運與可重複驗收](operations.zh-TW.md)。

### 雲端模型授權後的實測

| 項目 | 最新結果 |
| --- | --- |
| 帳號與模型設定 | 由原生 Dashboard 啟動裝置授權，使用者本人完成確認；讀回 `openai-codex` 已登入，再以原生模型設定介面選用帳號清單建議的 `gpt-6.1-sol`。舊設定已私人備份；未複製本開發對話的登入憑證。 |
| 官方 Paseo UI | 重新啟動 Paseo 後，使用原配對裝置，選定雲端模型及 Default 模式；首輪正確回覆隨機代碼，續聊記住未再次完整提供的代碼，測試 agent／工作區均歸檔。整段約 31.7 秒。 |
| 背景驗收 | 提交約 0.22 秒回傳 202，重新整理沿用同一工作，Dashboard 重載與關閉提交瀏覽器後仍完成。後端結果明確記錄雲端模型、首輪／續聊通過，以及 agent／工作區歸檔。 |
| 原生模型調用工具 | 原生 Hermes 雲端模型實際呼叫一次 `paseo_status`；最終 assistant 回傳 prompt 沒有提供的初始化 ID，退出碼 0。沒有用工具輸出或畫面 echo 代替最終回覆判定。 |
| 六個原生 handler | status、models、真實 chat／continue、stop／start 全部重新通過；完成歸檔。start 為背景啟動，測試等待 reachable 後才判定成功。 |
| 冷啟動與授權持久保存 | 容器重建約 70.5 秒無瀏覽器自動恢復，原配對與模型登入保留，預設仍為雲端模型；已登記依賴環境、ACP 工具範圍與 Origin 私有權限均保留。官方 UI 再次選模型，首輪與記憶續聊通過並歸檔，整段約 30.4 秒。 |
| 模式與防護重驗 | 雲端模型的 Default、Accept edits、Don't ask 經正式 SDK 切換，讀回 `runtimeInfo.modeId` 與 `currentModeId` 確認生效，最後還原 Default 並歸檔測試資料；此切換測試沒有發送模型訊息。重建後的未登入 401、跨 Origin 403、非法 body／profile query 400 與無意外重載也重新通過。 |
| 閒置本機引擎 | 透過原生介面停止不再使用的本機引擎並停用其自動啟動，保留模型檔。當下 cgroup 記憶體用量約由 4.09 GiB 降至 1.48 GiB，匿名記憶體減少約 2.59 GiB；重建後仍保持停用，雲端設定不變。這是同機前後觀察，並非容量或 SLA 承諾。 |

這次變更是測試服務的帳號與模型配置，插件實作及候選版 tag 未改動。此處的 ChatGPT／Codex 訂閱是 Hermes 的模型供應者，不代表已安裝獨立 Codex CLI companion。模型名稱與可用範圍以各帳號的實際清單為準。

### 已通過的真實流程

| 項目 | 結果與證據範圍 |
| --- | --- |
| 原生 Web 安裝／更新 | Plugins Git pull 與刪除後重新安裝皆完成；檢查回應內容及實際 Git SHA。HTTP 200 且 `ok:false` 的掃描阻擋不算成功。 |
| 初始化／配對 | 正常登入後自動進入引導、runtime 啟動、開啟官方 Paseo Connect，完成加密 relay 配對。 |
| 正式 Paseo UI | 從 `app.paseo.sh` 建立工作區、選模型、選 Default，首輪回覆及未重複提供完整 marker 的記憶續聊皆通過；以 daemon 的新 assistant 訊息確認，未使用畫面上的 user echo 判定。 |
| 模型／模式 | 實際列出 Hermes 模型；Default、Accept edits、Don't ask 在官方 UI 可見，三個模式透過正式 SDK 逐一切換後確認生效，再還原 Default。 |
| 插件背景驗收 | 修復後重跑 Web POST 約 0.13 秒回傳 202；首輪／續聊真實通過。重新整理沿用同一工作，關閉提交瀏覽器及重載 Dashboard 後仍完成；UI 顯示成功，驗收 agent 與工作區均歸檔、歷史保留。 |
| 原生 Hermes 工具 | 六個已註冊工具 handler 實測；status／models、真實 chat／continue、測試歸檔與停止／恢復皆成功。另由模型真正調用 `paseo_status`，回傳 prompt 未提供的初始化 ID，程序正常結束。 |
| 暫停／恢復 | 手動停止後重新整理仍維持暫停；恢復後可連線。`/paseo stop` 與 `/paseo start` 均實際執行。 |
| Dashboard 內重載 | 按插件頁「重載 Dashboard → 確認重載」，確認 generation 改變、API 恢復及頁面自動回來，無須進 PaaS。取消操作不重載。 |
| 原生停用／移除／重裝 | 先確認背景 daemon 已停止，再停用或刪除來源。重新啟用／安裝後，關閉瀏覽器且阻止前端送 start，主機仍自行恢復；設定、安裝身分與配對資料保留。 |
| Pod 重建 | 已測無瀏覽器的背景恢復；保留安裝身分，更新容器身分；保留必要 fsGroup，Origin 私有檔案重新掛載後仍為服務帳戶擁有且 600。修復 PM 後重跑約 73 秒恢復；ACP 工具配置修正後再重建約 80 秒恢復，實際工具範圍、已登記依賴環境及配對身分均保留。 |
| API 防護 | 未登入 401、跨 Origin 重載 403、非法 body 400、跨 profile／重複或多餘 query 均 400，且沒有意外重載。 |

早期測試使用透過 Hermes 原生本機模型介面安裝的 `Qwen3.5-0.8B-Q4_K_M` CPU 模型，後續改用上述雲端模型。兩者都是真實推論，不使用假的模型回覆。原生 Tool Search 對這個小模型的工具名稱與參數造成失敗，專用測試 profile 改為 eager 工具 schema 後，真正的工具調用曾通過；插件不會代替使用者修改模型登入或工具集白名單。先前不符合該主機 64K context 最低要求的模型被正常拒絕，沒有降低主機檢查。

### 修正與自動驗證

- Paseo 固定版本仍為 0.11.2，受管 runtime 依賴修訂為 `0.11.2-r2-71709cd7872f`；全新安裝的 npm runtime audit 為 0 項已知弱點。
- 修正 profile query 相容性、登入 middleware 順序、fsGroup remount、舊容器 PID 重用、單次控制程序完成後不退出，以及 `/paseo start` 未真正啟動的問題。
- 長時間模型驗收改為耐久背景工作，避免反向代理 HTTP 524。中斷會明確顯示未完成，不會自動重送可能付費的模型工作。
- 文字服務預設不下載未啟用的語音模型。主機 wrapper 依 cgroup／CPU affinity 設定 llama.cpp／OpenMP 預設執行緒；明確配置的值保留。
- 69 個 Node 測試及 70 個 Python 測試通過。React／Chromium UI 回歸覆蓋背景工作、重新整理、重載及重複提交；該組使用 mock API，與上述真實 relay／模型證據分開。
- [此實作的五組 CI](https://github.com/WOOWTECH/hermes-paseo-plugin/actions/runs/40185856336) 全數通過，包含最低與目前 Node／Python、瀏覽器驗證及供應鏈檢查。
- 狀態 API 的小樣本為 16 次請求、並行 4、錯誤 0；中位數約 73 ms、最大約 96 ms。這不是容量測試或 SLA。

### 修復後再驗證與使用限制

原生「Restart Gateway」與 PM 依賴阻擋已修復。原映像只有 in-tree 套件及依賴清單，內部啟動入口需要已登記環境；官方 `hermes pm repair` 原先因 5 GiB 磁碟不足失敗。取得擴容及副本遷移授權後，先建立第三份副本並確認三份均為 RW，再移除低空間節點的指定副本、恢復兩份健康副本，將此服務磁碟擴至 10 GiB 並完成 filesystem remount。未降低 Longhorn 空間門檻，也未改其他磁碟或全域設定。

官方修復以原本八個 extras 重建環境，退出碼 0；官方流程自行清除失敗標記，沒有手動刪除恢復標記或繞過依賴檢查。原生內部入口的版本查詢及 `acp --check` 均退出 0，Hermes 仍為 0.22.5。Dashboard 原生 Gateway 重啟已確認工作退出 0、s6 程序身分換新、Gateway Running 與 Paseo 可連線，無須進 PaaS。

修復後再重建容器，已登記環境保留、沒有修復標記，Paseo 無瀏覽器自動恢復。官方 Paseo 使用原裝置重新連線，實際選模型及 Default 模式，首輪與未提供完整 marker 的記憶續聊再度通過，agent 與工作區均歸檔。 插件背景驗收亦重新通過，提交約 0.13 秒回傳 202；重新整理、Dashboard 重載及關閉提交瀏覽器後仍完成，UI 成功與 agent／工作區歸檔均已確認。

此輪發現專用測試 profile 的 Tool Search 值誤含額外引號，導致小模型反覆搜尋工具而超時；以官方 `hermes config set tools.tool_search.enabled off` 修正後曾重新驗收通過。當時僅根據 YAML 判定 ACP 工具範圍不足，後續修正如下。全域 `hermes-cli` 白名單保留。原生 `plugins doctor` 與 `plugins validate` 也通過（6 個工具、1 個 hook）；validate 仍提醒程序身分檢查與主機 adapter 使用內部讀取介面，故版本相容性需依實測矩陣驗證。

實際 PVC 與 PaaS 保存的容量紀錄均已同步為 10 GiB，`persistence.data.size` 亦為 `10Gi`；重新讀取確認持久保存。只調整此測試服務兩個容量值，其他部署值不變，未更換訂閱方案或觸發平台重新部署。兩份磁碟副本維持健康。

### 早期本機模型的冷啟動反覆驗證

1. 首次重跑：小模型錯誤調用另一個插件的工具，未回覆測試代碼。實際解析發現，雖然 `platform_toolsets.acp` 只列 `hermes_paseo`，缺少 `known_plugin_toolsets.acp` 時 Hermes 0.22.5 仍會自動加入未記錄的插件。
2. 配置修復：該版 CLI 對 `--platform acp` 顯示不支援卻退出 0。使用同版原生工具選單的 `_save_platform_tools` 保存 ACP 選擇及已知插件後，重新解析只剩 `hermes_paseo`；比較確認一般 CLI 工具及其他配置不變。這是此測試服務的配置修復，插件不自動改使用者工具範圍。
3. 重建與再測：容器約 80 秒自動恢復，實際工具範圍及 Tool Search 設定保留。但相同官方 UI 對話測試再次逾時：0.8B 模型違反「不要使用工具」要求，調用 `paseo_chat` 建立額外代理。已取消／歸檔父測試代理，並依工具回傳的精確 ID 歸檔兩個子代理，保留歷史與共用工作區；確認沒有殘留的未歸檔 Hermes 測試代理。
4. 替代模型容量檢查：透過原生 Dashboard 下載流程取得 `Qwen3.5-2B-Q4_K_M`，模型原生 context 為 262144。以容器額度預留 Hermes 空間後，供模型的 4 GiB 預算被原生估算器拒絕；最低 64K 視窗估計約 5.0 GiB，256K 約 6.2 GiB。未啟用該模型、未降低 context 門檻、未增加主機資源；容量檢查後已用原生刪除流程移除此次下載，保留原模型並收回約 1.2 GiB 空間。
5. 隨後同配置的背景驗收通過：提交約 0.22 秒回傳 202，重新整理沿用同一工作，重載 Dashboard 及關閉提交瀏覽器後仍完成首輪／記憶續聊，UI 顯示成功，agent 與工作區歸檔均確認。這次成功證明背景流程可運作，但沒有消除前兩次冷啟動失敗，不能宣稱模型穩定性已修復。登入、跨 Origin 及非法請求防護亦重新通過。

模型下載成功、服務 ready、工具清單正確及單次對話通過，都不能取代反覆實測。使用者之後完成雲端模型授權，已依本頁上方紀錄重新通過首輪／續聊、工具操作及容器冷啟動驗收。上述本機模型失敗仍保留，不列為可穩定使用的測試配置。配置細節見 [ACP 工具範圍](install.zh-TW.md#小模型測試的-acp-工具範圍)。

目前不能宣稱無條件正式上線。另有以下範圍尚未驗證：

- 雲端模型授權與上述兩個雲端模型已實測通過；其他模型、額度耗盡、撤銷登入與長期 token 更新尚未逐一驗證。此 Hermes 容器未安裝獨立 Claude Code、Codex、Pi，不列為可用 companions。
- 語音／聽寫未啟用、未驗收。原映像缺少部分語音解壓縮工具；需要該功能時另行部署及測試。
- 已通過三路並行、插件資料還原及可控跨節點搬移；大量負載、長期 soak、整機／整卷災難復原、非預期節點故障及 SLA 仍未完成。
- 專用服務已通過 PaaS `.263`／chart `0.4.0` 的原生 Redeploy 與掛載保留；其他平台或未保存服務專用 values 的部署仍須另行驗收。

配對憑證、模型 API key、登入 cookie、對話逐字稿及測試帳號資料不放入公開驗收文件。

### PaaS 部署設定預檢（2026-10-25 後續）

已以平台實際組裝的服務 values 對候選 `hermes-agent` chart `0.4.0` 執行伺服器 dry-run。22 項比對通過；現有映像、環境、資源、安全設定、健康檢查與 PVC 符合預期，adapter 四個來源檔案與已安裝版本相同。Helm revision 與運行中的 Pod template 均未變動。

預檢發現三個既有 CPU 執行緒限制只保存在 Pod template，已補存至該服務 `extraEnv`；其他 Helm values 逐項比對不變。採用平台當下的 `10Gi`，避免沿用舊 Helm revision 的 `5Gi`。完整流程見 [部署前比對](dashboard-control.zh-TW.md#部署前比對與服務專用版本)。

當時正式平台為 `.261`，服務專用版本固定功能尚未部署，因此該次 dry-run 不列為 PaaS Redeploy 通過。2026-10-26 平台升到 `.263` 後，已完成下方的原生 Redeploy 實測。

後續已修復阻擋 chart CI 的測試工具缺陷：舊 Console checker 假定公開埠號的下一個埠可用，強制占用該埠可重現 missing listener／ttyd 與 `ConnectionRefusedError`。修正版為三個 listener 分別選埠，等待有期限的帶驗證 HTTP 回應，檢查自己的 ttyd，並遮蔽啟動失敗日誌中的憑證。新增 6 項回歸、24 次並行啟動與兩個 chart 的 fake／real ttyd 測試通過；沒有改動 Console 的 production template。原 CI 未保留子程序日誌，不能斷言原失敗執行的埠占用者。

Chart `0.4.0` 隨後通過 push／PR 全倉庫 CI 並發布。Gitea Helm 與 OCI 的回下載套件逐位元相同，全部 26 個檔案 hash 符合驗證候選；套件 SHA-256 為 `8e5918aa94237c51e36a1794e09414749dec05d68a05f47560643d5d7fa251ce`。Gitea index 未提供 digest，因此使用實際下載內容與候選檔案清單驗證，沒有將缺少的 index digest 誤記為已比對。

### 原生 PaaS Redeploy：2026-10-26

正式平台 ORM 確認為 `18.0.1.0.263`，服務專用版本固定欄位已可用。將專用測試服務設為 `pinned`、目標 chart `0.4.0`，固定原本已驗收的 Hermes 映像並保存 adapter values，再呼叫平台原生 `action_redeploy`。沒有直接執行手動 Helm upgrade，也沒有修改觀測版本帳本或共用商品範本。

- 原生動作約 39 秒返回；平台最終為 Running，部署核對完成且無錯誤。Helm 為 deployed、revision 3、chart 0.4.0；原版本為 revision 2／0.3.13。
- 新 Pod 在沒有開啟瀏覽器時自動恢復 Paseo；觀察程序約 85 秒確認 Ready／reachable。這段時間從觀察開始計算，並非完整停機時間或 SLA。
- 20 項部署比對通過：原映像與實際 imageID、環境、資源、安全設定、健康檢查、fsGroup、Helm 與實際掛載、保存及實際磁碟容量 10 GiB。兩個容器皆零重啟；Longhorn 為 healthy、兩份副本。
- 10 項身分／環境比對通過：安裝、伺服器與配對金鑰、正式 Origin 內容不變，Origin 為 600；模型登入、預設模型、CPU 限制、插件 commit 與已登記依賴環境保留；容器身分更新為新容器。
- 重新部署前建立的真實雲端對話，在部署後仍能回覆之前記住的隨機代碼；測試 agent／工作區歸檔。
- 官方 Paseo 使用已配對裝置重新連線，實際選取 `gpt-6.1-sol` 與 Default；首輪、新 assistant 訊息的記憶續聊及歸檔全部通過，約 30.6 秒。第一次 UI runner 參數誤用另一個模型顯示名稱，停在選單且沒有建立 agent／送出模型訊息；改用頁面實際名稱後重新驗證。
- Dashboard 背景驗收約 0.19 秒回傳 202；重新整理、確認重載 Dashboard 及關閉提交瀏覽器後仍使用同一工作，首輪／記憶續聊、UI 成功與歸檔全部通過。
- 六個原生 handler 再次通過：status、models、真實 chat／continue、stop／start；約 32.1 秒完成，等待恢復 reachable 才通過並確認測試資料歸檔。另由原生 Hermes 模型實際呼叫一次 `paseo_status`，最終 assistant 正確回傳 prompt 未提供的初始化 ID，退出 0。
- Default、Accept edits、Don't ask 透過正式 SDK 逐一切換，讀回 runtime／current mode 確認，再還原 Default 並歸檔；此項不發送模型訊息。
- 未登入 401、跨 Origin 403、非法 body／profile query 400 均通過，這些拒絕請求未觸發 Dashboard 重載。

## 歷史：0.1.2／Hermes 0.19

2026-10-12；以下為 0.1.2 首次對話驗收。使用者授權實測目標為 woowtech Hermes，Hermes 0.19.0 / Python 3.13.5 / Node 22.22.3。未升級 Hermes 映像或更改既有模型登入。

已使用 Hermes 的服務帳戶在 profile 專用目錄準備並啟動固定 Paseo 0.11.2 runtime。官方 ACP catalog 實測取得 13 個模型，以及 Default、Accept Edits、Don't Ask 三個模式；預設 `custom:chatgpt/gpt-5.6-sol`。

透過真實 Paseo daemon 建立 Hermes agent：首輪 assistant 正確回覆測試 marker；第二輪記住前文並回覆相同 marker。驗收通過並歸檔此次測試 agent，保留對話紀錄。CLI 存在或模型清單不被當作對話成功證據。

同容器尚未安裝 Claude Code、Codex、Pi，因此本次不宣稱三者已可對話。插件會偵測已安裝的 companions，登入需使用各官方流程。

固定 runtime 的執行依賴稽核為 0 項已知弱點。本機 Node/runtime/UI 測試 42/42，Python bridge/API 測試 42/42，均通過；跨程序狀態鎖、程序群組 timeout 清理、profile 隔離、背景啟動／停止競態、配對資訊遮罩、同源／body 檢查、UI 自動引導與暫停保存均有行為驗證。新增回歸涵蓋啟用中 daemon 中斷恢復、保留手動停止、HTTPS Origin 經 HTTP 反代、拒絕偽造 Forwarded 標頭與不安全 Origin 設定檔。

已從公開 repo 使用目標 Hermes 的官方 CLI 完成安裝與啟用，位置為 `/opt/data/plugins/hermes-paseo`，實作 source commit `f4398dc6bb471dd80c30dbe36cf19a0cbe73fed2`。原設定保存在同 profile 的私人備份，僅重載 Dashboard；重載後 health 200、ok=true、版本仍為 0.19.0。未登入的插件 API 返回 401，登入保護保留。

- [0.1.2 實作 CI](https://github.com/WOOWTECH/hermes-paseo-plugin/actions/runs/38213815753) 通過；公開 main 可匿名下載 ZIP（HTTP 200）。
- 安裝後重新完成 Hermes 首輪、記憶續聊及測試歸檔，全部通過。
- 實際 React／Chromium 的本機 DOM 驗證通過：啟用導向、第一次 start、手機 390 px、不在儲存體保存配對邀請、停止／恢復、卸載 UI 後停止輪詢。這部分的 API 為模擬資料。
- 另以正式插件的私人邀請完成官方 Paseo Connect，透過 relay 讀取本容器工作區，成功選取現有 Hermes 模型。
- 官方 Paseo UI 實際顯示 Default、Accept edits、Don't ask 三個模式；使用 Default 送出首輪與續聊，得到正確的記憶回覆，兩次測試均通過並已歸檔此次建立的 agent、保留紀錄。

每台主機的 Web 驗收須包含正常登入、GUI 安裝／啟用、插件載入後自動導向，以及從受保護頁產生配對。官方 CLI 安裝、Paseo UI 實測與模擬 DOM 不代替這一段。Hermes 0.19 安裝／啟用後須重新整理一次；遺失外部協定或 Host 的反代需由管理者設定精確正式 Origin，詳見 README。

Hermes 0.19 沒有公開插件建立全新 native 對話的介面：初始化使用耐久的插件流程紀錄，並可掛接後續真實 session，沒有虛構 Hermes 對話 ID。其首次安裝的 Dashboard API 需要重載一次。後續啟用由頁面引導進入配對流程。

支援範圍為 Linux 單一 Hermes profile。尚未建立長期 soak、大量並行模型對話或 SLA／容量承諾。

Hermes 0.19 停用／移除沒有公開卸載 callback：必須先用插件頁或 `/paseo stop` 停止 daemon，再停用／移除。不能把 host 關閉工具入口當作背景服務已停止。

此站台的 `toolsets` 限定為 `hermes-cli`；在此預設下，模型看不到新插件工具。這是原白名單保留的結果，Paseo 配對與 Hermes ACP 對話已正常。原生工具需單次使用 `--toolsets hermes_paseo` 或由使用者將該工具集納入 profile；此次沒有把全域白名單改成全部開放。

目標 0.19 的 CLI 沒有 `plugins doctor` 子命令，因此不宣稱已在該 CLI 跑過 doctor。已使用其官方 install／enable 及實際對話驗證；公開 CI 和本機 bridge 註冊測試另有明確範圍。

已再以 CLI 單次選取 `hermes_paseo` 工具集，讓模型僅調用 `paseo_status` 並回傳真正、不可猜測的初始化 ID；回傳值吻合，且初始化紀錄已掛接真實 native session。原 profile 的 `hermes-cli` 白名單保持原樣。

## 0.1.3：Dashboard 內重載

在配置主機端 adapter 的 s6 Hermes 環境，以正常登入的 Chromium 完成原生 Plugins Git pull 更新，以及 Paseo 頁的「重載 Dashboard → 確認重載」。確認伺服器 generation 改變、插件 API 恢復、自動重新整理原頁、Paseo daemon 可連線及配對按鈕可操作；手機尺寸也可看到控制按鈕。

取消操作保留原 generation。未登入與跨 Origin 的重載請求均被拒絕，沒有重啟程序。原生 Hermes 版本及 ACP 指令仍可使用。此段驗證重載與初始化控制流程，模型首輪／續聊驗收見上方紀錄。

實測發現 volume remount 的 fsGroup 會把 Origin 私有檔案從 600 改為 660。已加入檢查既有 profile UID 的部署選項，保留原有私有檔案檢查；重新執行 Origin 設定後，在真實 Pod 重建與 volume remount 下仍維持 600。

本機 Node/runtime/UI 測試 48/48、Python bridge/host/installer 測試 51/51 通過；[實作與修正 CI](https://github.com/WOOWTECH/hermes-paseo-plugin/actions/runs/38234388548) 通過。回歸包含 SPA 兜底路由順序、首次 API 404、明確確認、重複點擊、斷線觀察、不同 generation 與 API readiness、timeout、保留手動暫停、服務 PID 驗證、Origin/body 防護及拒絕錯誤 profile UID。

此功能要求一次性 [主機端設定](dashboard-control.zh-TW.md)。一般插件安裝不會自行改寫主機 CLI；沒有主機介面時按鈕會停用。Kubernetes 手動掛載與儲存選項需要納入正式部署模板，才能在 Helm 重建工作負載時保留。
