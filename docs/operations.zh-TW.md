# 維運與可重複驗收

本頁適用 Linux、單一 Hermes profile、受管 Paseo 0.11.2 runtime。先在專用測試服務執行；測試會建立真實模型對話並使用帳號額度。模型名稱以該 Hermes 帳號的實際清單為準。

## 備份內容與還原範圍

Paseo 插件資料位於 `$HERMES_HOME/plugin-data/hermes-paseo`。可重建的 npm runtime 與語音模型快取不等於對話資料；保留快取可以縮短恢復時間，但不能拿快取當備份。

這次實測備份包含：

- `state.json`、`onboarding.json`、`dashboard-origin.json`、`host-lifecycle.json`。
- 若存在，包含 `connection.json`（連線標的）、`preferences.json`、`acceptance-job.json`。0.1.5 起不再寫入 `pairing.private.json`：配對邀請等同存取憑證，只交給呼叫者；舊版留下的檔案會在下次啟用時刪除，不需要備份。
- `daemon/` 的持久資料，包括安裝所有權、伺服器身分、配對金鑰、agents、projects 與 runtime 資料；排除 `models/`、日誌和停止前的 PID 檔。
- 測試工作目錄，讓還原前建立的對話可以在原路徑繼續使用。

備份含憑證與歷史，必須留在私人備份儲存位置。檔案使用 `600`、目錄使用 `700`，不放進 GitHub、公開下載或一般測試報告。

## 已實測的離線插件還原順序

1. 確認沒有使用中的對話或背景驗收工作。先用 Hermes 插件的「停止」保存暫停意圖，再確認 daemon 已退出。不要只停程序而讓主機自動啟動它。
2. 在停止狀態讀取備份。每個檔案建立 SHA-256 與大小清單；拒絕符號連結、硬連結及特殊檔案。將備份傳至另一個私人儲存位置，重新讀取並校驗。
3. 先解開至新的私人暫存目錄。驗證相對路徑、檔案類型、大小、checksum、安裝身分與配對身分，全部通過才替換原資料。這個實測流程只支援相同的 profile 路徑與服務 UID。
4. 原資料移至私人回復目錄；保留原 runtime 與模型快取。失敗時把原資料移回，成功驗證前不刪回復副本。
5. 確認 Origin 權限與正式網址相符，透過插件恢復服務。使用還原前的對話要求記憶續聊，再用既有瀏覽器的官方 Paseo 配對建立新對話；最後歸檔本次測試資料。

這項測試保留 Hermes 本身的設定、模型登入與原生 session 儲存，因此它證明的是**插件資料還原**。整台 Hermes／PVC 遺失時，還必須復原 Hermes 原生 profile、工作目錄與部署設定；目前不把這項測試列為整機災難復原或完整備援驗收。

## 跨節點測試

以專用 StatefulSet 的暫時排程條件，讓相同 PVC 在另一個健康節點重新掛載。確認新 Pod、原安裝與配對身分、私有 Origin 權限、無瀏覽器自動恢復，以及官方 Paseo 的實際兩輪對話，再移除暫時條件並重新確認服務可用。

這是可控的跨節點重新排程；沒有關閉共享節點、強制卸載磁碟或模擬網路分割，不能推論為所有節點故障情境已通過。

## 連線標的與切換

0.1.5-rc.1 起，daemon 連線的 relay 與網頁 App 可以由**連線標的**決定：`paseo`（預設）、`woowtech`（Woowtech Smart）、`apporo`（Apporo Smart）。三組各是固定的網頁 App 加自己的 TLS relay，沒有任何請求能帶入其他網址：

| id | 網頁 App | relay |
|---|---|---|
| `paseo` | `https://app.paseo.sh` | `relay.paseo.sh:443` |
| `woowtech` | `https://smart.woowtech.io` | `relay.woowtech.io:443` |
| `apporo` | `https://smart.apporo.ai` | `relay.apporo.ai:443` |

- **舊模式與管理模式（選擇才生效）**：`connection.json` 不存在時，沿用 rc.9 的 App／relay／CORS 行為，不新增標的設定覆寫、不要求品牌補丁、不做標的設定備份。安全 runtime 仍會安裝至獨立 r3 目錄。狀態為 `selectedTarget: paseo`、`targetSaved: false`；第一次儲存標的（包含 Paseo）後，下一次 daemon 啟動才套用其設定。
- **保存位置**：`plugin-data/hermes-paseo/connection.json`，內容是 `{"version":1,"target":"<id>"}`，權限 `600`。這個檔案刻意**不是** `preferences.json`：rc.9 遇到沒有顯示名稱的 `preferences.json` 會拒絕啟動，回滾必須行得通。檔案不存在代表舊模式；內容無法辨識（壞掉、版本不符、多出欄位、不是三個 id 之一）時，狀態回報 `connectionCode: CONNECTION_STATE_CORRUPT`，Dashboard 暫時顯示 Paseo、說明原因、不產生配對連結，啟動也停在這個代碼，**不會**被當成預設值；在插件頁儲存目前顯示（或重新選擇）的標的即可取代壞掉的紀錄。路徑經過符號連結時回報 `UNSAFE_SYMLINK`：插件不會跟隨或取代它，畫面也不提供儲存，必須由管理者處理該路徑。
- **儲存**：Dashboard 的 **儲存連線標的** 呼叫 `POST /api/plugins/hermes-paseo/config`，本體只有 `{"target":"<id>"}`；同樣經過 Origin、Fetch Metadata、JSON 與大小檢查。對應的 `control.mjs config` 也只收 `target`。它不是模型工具（沒有 `paseo_config`）。儲存只寫 `connection.json` 與狀態旗標，**不詢問任何 daemon、不取用 runtime 鎖**：啟用中的 `npm ci` 可以持鎖數分鐘，儲存不必等它。
- **等待套用**：標的改變時，設定標為待套用（`configurationPending`）、清除舊標的的 relay 驗證結果與配對紀錄，並保留 daemon 的 server ID 與金鑰。**只有下一次停止再啟動才會套用**；選回目前執行中的標的則不算待套用。第一次儲存而且選的就是目前顯示的 Paseo 不算變更，不會待套用，但它的設定也要到下一次啟動才寫入。狀態回報 `selectedTarget`（已儲存的）、`targetSaved`（是否有人儲存過）、`activeTarget`（執行中 daemon 啟動時的標的；停止時為 `null`）與 `configurationPending`。環境裡沒有標的紀錄的 daemon（rc.9 或舊模式啟動的）視為 `paseo`。
- **待套用期間**：`pair` 與 `relay` 在向 daemon 要配對邀請或對外連線之前就回報 `CONFIGURATION_PENDING`（只讀取狀態）；對已在執行的 daemon 再按「啟動」只會回報待套用，不改寫設定、不重載。
- **套用（管理模式）**：每次啟動 daemon（沒有 daemon 在執行時）才寫入 `app.baseUrl`、`daemon.relay`（`enabled`、`endpoint`、`publicEndpoint`、`useTls`、`publicUseTls`）與 `daemon.cors.allowedOrigins`，並以環境變數 `HERMES_PASEO_CONNECTION_TARGET` 把標的交給 daemon（名稱不以 `PASEO_` 開頭，因為受管的 `daemon start` 會移除那些變數）。不屬於三個標的的 CORS 來源保留，三個 App 的來源以 `URL.origin` 比對，所以 `HTTPS://smart.apporo.ai`、結尾斜線或預設連接埠的寫法與標準寫法視為同一個而不會重複列出；有路徑、查詢或使用者資訊的項目是別人的設定，保留。`daemon.relay.requireProtectedSecurity` 不寫入（0.11.2 的嚴格設定檔沒有這個欄位，寫了整份設定會失效）。已在執行的 daemon 的 relay 端點與 TLS 不能即時重載，所以對它們不寫入這些設定。
- **一次性備份**：進入管理模式後，第一次為所選標的改寫 `daemon/config.json` 之前，插件把它複製成同目錄的 `config.json.pre-agent-connect`（權限 `600`、一般檔案，以暫存檔寫完整再用 `link()` 放到位，所以不會留下寫到一半的備份）。只做一次（狀態檔 `configBackup` 記錄）；任何已存在的備份（不論是檔案、目錄或別人放的）都不覆蓋；不經過符號連結；`config.json` 不是一般檔案（目錄、FIFO）時回報 `CONFIG_CORRUPT`，不會卡住啟動。沒有 `config.json`（全新安裝）就沒有可備份的內容。備份失敗（`CONFIG_BACKUP_FAILED`、`UNSAFE_SYMLINK`）時不改寫 `config.json`，daemon 不啟動，修好後再試一次。**還原**：停止服務，確認已停止，再執行 `cp -p config.json.pre-agent-connect config.json`；要回到舊模式（插件不再寫入任何標的設定）還要刪除 `plugin-data/hermes-paseo/connection.json`，然後恢復服務。保留 `connection.json` 的話，下一次啟動又會寫入所選標的的設定。
- **管理模式會覆蓋自訂值**：管理模式下，每次啟動 daemon 都用所選標的（Paseo 也一樣）的值寫入 relay、App 網址與 CORS 來源，所以 `config.json` 裡自訂的 relay 與 App 網址，在切換標的時、沒有切換只是停止再啟動時，都會被覆蓋。其他設定保留。需要自訂值的服務不要儲存標的。
- **配對連結**：`<網頁 App>/#offer=…`，只放行所選標的的精確網址：Node 端檢查 App 網址、路徑 `/`、`#offer=` 片段，邀請必須是版本 2、帶 server ID 與金鑰；管理模式再要求 relay 端點是該標的的且為 TLS，舊模式與 rc.9 一樣不核對 relay（租戶可能自己架 relay）。Python 端再用 `connection.json` 的標的獨立檢查一次。Smart 標的若收到要求最低安全模式的邀請會回報 `PAIRING_SECURITY_UNSUPPORTED`（0.11.2 不會送出這種邀請，這只是防護）。邀請不寫入任何檔案；舊版留下的 `pairing.private.json` 在儲存標的與管理模式啟動時刪除，舊模式不刪。

| 代碼 | 意思與處理 |
|---|---|
| `CONFIGURATION_PENDING` | 已儲存的標的還沒套用。停止再啟動服務。 |
| `INVALID_TARGET` | 請求的標的不是三個 id 之一。 |
| `CONNECTION_STATE_CORRUPT` | `connection.json` 內容無法辨識。Dashboard 暫時顯示 Paseo、不產生配對連結，啟動也停在這個代碼；在插件頁儲存目前顯示（或重新選擇）的標的即可取代它。 |
| `UNSAFE_SYMLINK` | 路徑上有符號連結（外掛資料目錄、`connection.json`、`daemon/config.json`、備份檔、runtime 的 `websocket-server.js` 或輔助檔）。插件拒絕跟隨或取代，什麼都沒有被寫入。管理者用 `find plugin-data/hermes-paseo -type l` 找出連結並移除，或還原成一般檔案，再重試；`connection.json` 是連結時畫面不提供儲存。 |
| `BRAND_IDENTITY_SOURCE_MISMATCH` | 選了 Smart 標的，但 `websocket-server.js` 的 SHA-256 不是已知的原版或補丁版（被改過、被別的版本取代、不存在，或不是一般檔案，例如 FIFO）。沒有改任何檔案，daemon 不啟動。改選 Paseo 即可啟動（Paseo 不需要補丁）；要用 Smart 標的，把檔案還原成 0.11.2 的原版。 |
| `BRAND_IDENTITY_PATCH_MISMATCH` | 補丁寫入後驗證失敗（雜湊或輔助檔不符）。插件已把原檔放回，daemon 不啟動。多半是檔案系統問題或另一個程式同時改動該目錄；先改選 Paseo 恢復服務，再請管理者檢查 runtime 目錄。 |
| `RUNTIME_NOT_READABLE`／`RUNTIME_NOT_WRITABLE` | 插件讀不到或寫不了 runtime 目錄裡的 `websocket-server.js` 或輔助檔（權限不足、唯讀檔案系統）。只有選 Smart 標的才會遇到，Paseo 不碰這些檔案。讓服務帳戶對 `plugin-data/hermes-paseo/runtime` 有讀寫權限（或掛成可寫）再重試，或改選 Paseo。 |
| `CONFIG_BACKUP_FAILED` | 無法備份 `daemon/config.json`（權限不足、磁碟已滿、檔案系統不支援）。`config.json` 沒有被改寫，daemon 不啟動。修好 `plugin-data/hermes-paseo/daemon` 的權限或空間後重試。 |
| `CONFIG_CORRUPT` | `daemon/config.json` 不是合法 JSON，或不是一般檔案。修好或移走它（先留一份），再啟動。 |
| `CONFIG_INVALID` | 要寫入的設定不被 Paseo 0.11.2 的嚴格設定檔接受（例如 `daemon.cors.allowedOrigins` 不是字串陣列）。修正 `config.json` 該欄位後再啟動。 |
| `PAIRING_ORIGIN_INVALID` | daemon 給的連結不是所選標的的網頁 App，通常是 `config.json` 的 `app.baseUrl` 被手動改過。管理模式下**每一次**停止再啟動都會用所選標的的值重寫 `app.baseUrl`、relay 與 CORS（不一定要切換標的），所以停止再恢復服務即可；舊模式不重寫，需要自己修回 `config.json`，或儲存一個標的。 |
| `PAIRING_TARGET_MISMATCH` | 邀請的 relay 端點或 TLS 不是所選標的的（管理模式），或邀請缺少 server ID／金鑰。處理同上：管理模式下停止再啟動即重寫。 |
| `PAIRING_OFFER_INVALID` | 邀請無法解碼。 |
| `PAIRING_SECURITY_UNSUPPORTED` | Smart 標的收到要求最低安全模式的邀請，這些 App 無法回答。改用 Paseo 的網頁 App。 |
| `INVALID_PAIR_URL` | Python 端的獨立檢查拒絕了連結（網址或標的與 `connection.json` 不符）。 |

## 品牌識別補丁與升級

Woowtech Smart 與 Apporo Smart 的網頁 App 要求 daemon 的握手（`server_info`）帶有 `brand: {id, name}`；上游 Paseo 0.11.2 不送。作法與 Pi 的 Agent Connect 相同：以雜湊釘住的補丁在 `node_modules/@getpaseo/server/dist/server/server/websocket-server.js` 的 `status: "server_info",` 之後加一行 `brand: agentConnectBrand,`，檔首加一行 import，並在同一目錄放輔助檔 `hermes-paseo-brand-identity.mjs`。輔助檔讀取環境變數 `HERMES_PASEO_CONNECTION_TARGET`（未設定即 `paseo`，其他非三個 id 的值使 daemon 無法載入該檔而啟動失敗，這是故意的封閉式失敗）。

- 原檔 SHA-256 `ba8122d01dd17533231a573097ec4e9f91f4fd12caada107adb9f6706f5f8950`，補丁後 `7c4d2a764e2971da9cdcbc8c93cc5f467f632b04d55e1a3a8334abad8cd9abaf`。輔助檔檔名是本插件自己的，所以補丁後的雜湊與 Pi 插件的不同；以 Pi 的檔名做同樣的轉換，得到該插件的補丁雜湊，測試以此證明兩者是同一個轉換。
- **補丁與安全 runtime 分開**：rc.2 的 runtime 位於 `runtime/releases/0.11.2-r3-523d451cc096`。就緒收據僅包含確切 revision 與鎖定檔 SHA-256，另核對 CLI／server 都是 0.11.2；品牌補丁不在就緒條件內。`prepare` 絕不套補丁，補丁失敗也不觸發重新安裝。
- **何時套用**：只有 Smart 標的（`woowtech`、`apporo`）需要補丁，也只有已儲存這兩個標的的啟動才會補：在 daemon 啟動前、持有 runtime 鎖、確認沒有 daemon 從該 release 目錄執行時，就地補在已安裝的 runtime 上（本版只啟動 r3，保留的 r2 不改動）。**安裝與補丁是兩件事**：補丁不屬於「runtime 已就緒」的判定，所以補丁失敗不會讓下一次嘗試重新執行 `npm ci`。Paseo 與舊模式不補丁、也不要求補丁：`websocket-server.js` 被改過、讀不到或唯讀都不會影響它們啟動；已補丁的 runtime 對 Paseo 原樣保留（沒有環境變數時輔助檔的品牌就是 `paseo`）。執行中的 daemon 絕不會被這件事重啟，它保持沒有品牌的握手直到下一次停止再啟動。
- **安全**：先寫輔助檔（補丁後的檔案會 import 它），再以「暫存檔加 rename」寫入 `websocket-server.js`，兩個檔案的雜湊寫完後都再驗證，驗證失敗會把原檔放回；原檔雜湊未知、補丁後的檔案被改過、路徑上任何一層是符號連結、或該路徑不是一般檔案（FIFO 等以非阻塞方式開啟後判定，不會卡住啟動）時一律拒絕，並且不改任何檔案（`BRAND_IDENTITY_SOURCE_MISMATCH`、`BRAND_IDENTITY_PATCH_MISMATCH`、`UNSAFE_SYMLINK`）；權限不足或唯讀檔案系統回報 `RUNTIME_NOT_READABLE`／`RUNTIME_NOT_WRITABLE`。拒絕時 daemon 不會啟動，各代碼的處理見上節的表。
- **檢查**：`sha256sum node_modules/@getpaseo/server/dist/server/server/websocket-server.js`（在該 release 目錄下）等於補丁後雜湊，且同目錄有輔助檔，表示已補丁。
- **回滾**：rc.9 使用自己保留的 r2 runtime，不把 r3 當成 rc.9 的安裝。r2 即使曾被 rc.1 加過 Smart 補丁，rc.9 的就緒條件仍接受它；沒有標的環境變數時品牌是 `paseo`。

## PaaS 自動更新器與本版

0.1.5-rc.2 保持 `host/` 與 rc.9 位元組相同，`plugin.yaml` 只有版本行不同。`runtime/package*.json` **已改變**；chart 0.4.9 的 `dependency_manifest_changed` 閘門會拒絕，必須搭配 chart **0.4.10** 審核與部署。以下是外掛對 rollout 的契約，不是已完成的叢集驗收。

允許清單須同時匹配兩個完整 SHA-256（不可只按 Paseo 版本放行）：

| 檔案 | SHA-256 |
|---|---|
| `runtime/package.json` | `42a34afe83cb3d2733277d1251df8164dd22bf5874aaceac01dbc991602f067b` |
| `runtime/package-lock.json` | `523d451cc096c7ded2e8a92c3107021d48fc6768cdfc543e94b68a134649f240` |

1. 以相同服務 UID／profile 環境，在已審核的候選版目錄執行 `node bin/control.mjs prepare`，stdin 為 `{}`。預算 **480 秒**（鎖等待上限 120 秒、npm 上限 300 秒及驗證／狀態時間）。正在服務的舊 daemon 保持運作。
2. **只有退出碼 0 且 JSON 的 `installed` 是布林值 `true` 才能繼續**。沒有 `configCheck` 契約，也不做 0.17.4 的設定正規化或內建 Hermes provider 遷移。失敗為非零退出碼、`installed: false`、安全的 `code`／`prepare` 資訊；不回傳 npm 原始輸出、秘密或私人路徑。
3. 成功後才停止舊 daemon、安裝候選插件並啟動。啟動仍需獨立健康檢查；`prepare` 只保證 runtime 安裝與版本驗證，不證明模型、relay 或應用服務健康。
4. 回滾時先以新版停止新 daemon，再還原插件並啟動保留的 r2。chart 的 start 預算不應拿來重新下載 runtime。

`prepare` 可重複呼叫：已就緒時只重新驗證，不再 npm、不改收據、不等待 runtime 安裝鎖。它不建立 daemon home、不修改 `desiredEnabled`／服務 phase、不改 config、server ID、金鑰或選擇的標的。對執行中的 r2，status／配對／對話／停止只載入那份確切 r2 的模組；即使同樣是 Paseo 0.11.2，也不以版本號推測 revision。未知、缺收據或被替換的 runtime 不會轉用任意目錄控制 daemon。

Dashboard／主機輪詢發現執行中的舊版時會背景準備。失敗使用 30、60、120、300、600、900 秒（之後維持 900）退避，本 Dashboard 程序最多 8 次；用完後由使用者按「立即重試準備」。準備失敗不會永久標記已嘗試、不會把正在服務的 daemon 顯示為啟動失敗、不會自動暫停。明確停止仍可使用，若準備尚在執行，停止會排在後面；準備失敗不阻止已要求的停止。

### 容量與清理

- 安裝前使用檔案系統的可用空間檢查，至少 **1536 MiB**；不足回報 `INSUFFICIENT_DISK`（`requiredMiB`／`availableMiB`），不停止或刪除舊服務。無法讀取 statfs 時沿用 npm 安裝及失敗處理，不能視為容量已保證。
- npm cache 位於本次新 runtime 的 `.npm-cache`，成功後刪除；失敗則安全丟棄整份部分安裝，重試從乾淨目錄開始。只有空目錄或本外掛 manifest、當前 UID 擁有且非符號連結的目錄可丟棄；執行中 runtime 不刪。
- 只有確認 glibc 時，移除未使用的 `@anthropic-ai/claude-agent-sdk-*-musl` 原生 SDK 目錄；musl 與其他主機保留。
- 只有新版 daemon 成功啟動且可連線後才清理已知 r1。**最新前版 r2 一律保留，即使空間偏低**：這刻意不同於暫緩 0.17.4 分支的低空間政策，確保回滾不需下載。若容量不夠，寧可準備失敗並保留舊服務。
- 清理檢查確切 receipt／manifest／套件版本、目錄擁有者，以及整張同 UID 程序表（含其他 profile 的 worker）。先檢查 `/proc/<pid>` 擁有者，跳過其他 UID 的 root／s6 程序；同 UID metadata 不可讀即保留。殭屍程序無執行映像，不算使用中。未知／未來 revision、連結或仍被使用的 runtime 一律不動；無可用 Linux 程序證據時保留。

`RUNTIME_INSTALL_FAILED`／`RUNTIME_INSTALL_TIMEOUT` 可在修好網路後重試；`INSUFFICIENT_DISK` 先清出空間；`RUNTIME_IN_USE` 表示 runtime 仍被程序使用或無法安全確認；`RUNTIME_NOT_OWNED`／`UNSAFE_SYMLINK` 需檢查路徑，不能強制刪除。

Release 仍需等 chart 0.4.10 部署、沙盒與回滾驗收，以及五項 GitHub 檢查全綠。pre-release 仍會被更新器選中，不能用 pre-release 旗標替代 rollout 閘門。本次只做本機實作與驗證，未推送、合併、打 tag、發布或改動服務。

## 回滾到 0.1.4-rc.9

0. 先確認 r2 runtime 保留，並用 rc.2 停止 r3 daemon 後才切換舊版程式碼。從沒儲存標的時連線設定仍是 rc.9 的；已儲存 Smart 標的時，先做下一步切回 Paseo，再停止及降版。
1. **先在插件頁切回 Paseo**：選 **Paseo**、儲存，按 **停止服務** 再 **恢復服務**，確認畫面沒有「標的已儲存…」的提示，產生的配對連結是 `app.paseo.sh`。要連 relay 與 App 網址的自訂值也一併拿回，再依上節「一次性備份」的步驟還原 `config.json.pre-agent-connect`。
2. 再降到 0.1.4-rc.9（Git 切換或更新器回滾）。rc.9 使用保留的 r2 runtime、不需重新安裝；新版寫下的 `config.json`（app、relay、CORS）rc.9 照原樣保留，且是 0.11.2 設定檔接受的內容。
3. 若沒有先切回 Paseo：rc.9 的 daemon 仍會啟動，但 rc.9 只放行 `app.paseo.sh` 的配對連結，所以在 Smart 標的下它會拒絕產生配對連結（`PAIRING_ORIGIN_INVALID`）。補救方式是重新升到 0.1.5-rc.2、切回 Paseo、停止再啟動，然後再降版。
4. 已配對的裝置不受影響：server ID 與金鑰在整個切換與回滾期間都沒有改變。

## 驗證官方 relay 迴路

Dashboard 啟動流程在 daemon 就緒後會自動做一次（從未驗證或上次成功已超過 24 小時才做，失敗不影響配對與對話）。啟動流程由使用者開啟 Paseo 頁面觸發，Pod 重啟或 PaaS 自動更新後不會自動重做；需要最新結果時可以隨時手動重做，不需要瀏覽器，也不會呼叫模型：

```bash
node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" relay <<< '{}'
```

回傳的 `daemon.relayVerified` 與 `relayVerifiedAt` 就是結果；失敗時輸出 `{"ok":false,"code":"RELAY_UNVERIFIED"}` 並以非零結束。常見原因是 Pod 不能出站連到所選標的的 relay（`relay.paseo.sh:443`、`relay.woowtech.io:443` 或 `relay.apporo.ai:443`）、daemon 的 relay 被設定關閉，或該 relay 暫時不可用。檢查用 daemon 自己給的邀請連線，而官方用戶端依邀請內的 relay 端點連線，所以每個標的驗到的是它自己的 relay；結果記下是哪個標的的（切換標的後舊結果作廢）。待套用期間回報 `CONFIGURATION_PENDING`。這個檢查只證明 relay 到本 daemon 的路徑；要確認使用者端能用，仍須從所選標的的網頁 App 實際配對一次。

## 發佈新版與 PaaS 自動更新

啟用 Hermes chart 的 `paseoAutoUpdate`（0.4.3 起含回滾）的 PaaS 服務，每天在排程時間檢查本 repo **最新已發布的 release**，符合以下全部條件才安裝；任何一項不符就拒絕（Job 顯示失敗，外掛不動）：

- release 的 commit 在 `main` 上，且 `Unit tests`、`Browser`（各兩組）與 `Locked dependency audit` 五項檢查**每項最新一輪**都成功。
- `host/` 的四個主機轉接檔逐位元組不變；`plugin.yaml` 除 `version` 行外不變，且 `version` 等於 tag；`package.json` 沒有相依套件。
- Hermes 原生安全掃描沒有新增項目（以 pattern、severity、category、檔案、說明比對，不含行號；同檔同模式多出一處仍會被擋）。

發 release 時請注意：

1. **tag 一推就會再跑一輪 CI**（約 1–2 分鐘；Chromium 安裝偶爾卡住，要重跑）。這段時間排程剛好執行，會因為檢查還沒全綠而拒絕，不計入失敗次數，隔天再試。要立刻更新時，先等這一輪綠燈。
2. 變更 `host/`、`plugin.yaml` 能力或新增相依套件的版本不會被自動安裝，需要另外發 chart／HA 映像。0.1.5-rc.2 保留原有 host 與能力，修復 rc.1 的兩項相依套件弱點；新 runtime manifest pair 及停止前準備流程需要 **chart 0.4.10** 配合，見下面[本版的說明](#paas-自動更新器與本版)。
3. 更新後若重載的 Dashboard、daemon 或 Plugin Doctor 不健康，更新器會自動裝回上一版、重啟 daemon 並再重載一次，Job 仍標示失敗以便察覺；失敗的版本只重試一次，之後要等更新的 release。
4. 多台服務各自排程、互不把關。要先在專用服務驗證時：暫停其他服務的 CronJob（`spec.suspend: true`），在專用服務以 `kubectl create job --from=cronjob/<名稱>` 手動執行並驗證，通過後再逐台執行並恢復排程。rc.6 就是這樣發佈的。

## 發版前的判定

驗收必須分別記錄：模型回覆、記憶續聊、測試資料歸檔、服務健康與部署設定保留。收到 HTTP 202、Pod Ready、模型出現在選單或能開啟頁面，都不是對話成功證據。短時間並行與狀態請求樣本也不構成容量上限、長期穩定性或 SLA 承諾。

## 並行對話驗證工具

在已安裝本版來源、已配對且已登入模型的 Hermes，以原服務帳戶執行：

```bash
cd "$HERMES_HOME/plugins/hermes-paseo"
node tests/live-concurrency.mjs --help
node tests/live-concurrency.mjs --run --model YOUR_EXACT_HERMES_MODEL_ID \
  --concurrency 3 --rounds 2
```

`--model` 必須使用 Paseo 的 Hermes 模型清單中的完整 ID，也可使用 `HERMES_PASEO_LIVE_MODEL`。未帶 `--run` 不會連線或呼叫模型。每段成功的對話正好兩輪；預設三路並行、一輪，最多四路及兩輪、共八段，不會自動重送模型請求。

每段使用獨立工作目錄、工作區與 agent。首輪回覆自己的隨機代碼，續聊不再提供代碼，驗證新的 assistant 訊息及不同對話之間的記憶隔離，最後確認歸檔。錯誤或逾時仍會嘗試清理；建立結果或清理無法確認時停止後續輪次，不會顯示通過。

`stdout` 與 `metrics.json` 只提供經篩選的指標。私人執行目錄中的 `recovery.private.json` 保存本次資源 ID 與操作狀態，供中斷後人工復原；不應公開。測試保留已歸檔的歷史與工作目錄。單次失敗不能只重跑至成功：先查明原因並確認沒有未歸檔工作，再進行下一次測試。
