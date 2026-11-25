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

0.1.5-rc.1 起，daemon 連線的 relay 與網頁 App 由**連線標的**決定：`paseo`（預設）、`woowtech`（Woowtech Smart）、`apporo`（Apporo Smart）。三組各是固定的網頁 App 加自己的 TLS relay，沒有任何請求能帶入其他網址：

| id | 網頁 App | relay |
|---|---|---|
| `paseo` | `https://app.paseo.sh` | `relay.paseo.sh:443` |
| `woowtech` | `https://smart.woowtech.io` | `relay.woowtech.io:443` |
| `apporo` | `https://smart.apporo.ai` | `relay.apporo.ai:443` |

- **保存位置**：`plugin-data/hermes-paseo/connection.json`，內容是 `{"version":1,"target":"<id>"}`，權限 `600`。檔案不存在代表 Paseo；內容無法辨識（壞掉、版本不符、多出欄位、不是三個 id 之一）或路徑經過符號連結時回報 `CONNECTION_STATE_CORRUPT`／`UNSAFE_SYMLINK`，不會被當成預設值；在插件頁重新儲存一次即可取代壞掉的紀錄。這個檔案刻意**不是** `preferences.json`：rc.9 遇到沒有顯示名稱的 `preferences.json` 會拒絕啟動，回滾必須行得通。
- **儲存**：Dashboard 的 **儲存連線標的** 呼叫 `POST /api/plugins/hermes-paseo/config`，本體只有 `{"target":"<id>"}`；同樣經過 Origin、Fetch Metadata、JSON 與大小檢查。對應的 `control.mjs config` 也只收 `target`。它不是模型工具（沒有 `paseo_config`）。儲存只寫 `connection.json` 與狀態旗標，**不詢問任何 daemon、不取用 runtime 鎖**：啟用中的 `npm ci` 可以持鎖數分鐘，儲存不必等它。
- **等待套用**：標的改變時，設定標為待套用（`configurationPending`）、清除舊標的的 relay 驗證結果與配對紀錄，並保留 daemon 的 server ID 與金鑰。**只有下一次停止再啟動才會套用**；選回目前執行中的標的則不算待套用。狀態回報 `selectedTarget`（已儲存的）、`activeTarget`（執行中 daemon 啟動時的標的；停止時為 `null`）與 `configurationPending`。0.1.5 之前啟動、環境裡沒有標的紀錄的舊 daemon 視為 `paseo`。
- **待套用期間**：`pair` 與 `relay` 在向 daemon 要配對邀請或對外連線之前就回報 `CONFIGURATION_PENDING`（只讀取狀態）；對已在執行的 daemon 再按「啟動」只會回報待套用，不改寫設定、不重載。
- **套用**：每次啟動 daemon（沒有 daemon 在執行時）才寫入 `app.baseUrl`、`daemon.relay`（`enabled`、`endpoint`、`publicEndpoint`、`useTls`、`publicUseTls`）與 `daemon.cors.allowedOrigins`，並以環境變數 `HERMES_PASEO_CONNECTION_TARGET` 把標的交給 daemon（名稱不以 `PASEO_` 開頭，因為受管的 `daemon start` 會移除那些變數）。不屬於三個標的的 CORS 來源保留；`daemon.relay.requireProtectedSecurity` 不寫入（0.11.2 的嚴格設定檔沒有這個欄位，寫了整份設定會失效）。已在執行的 daemon 的 relay 端點與 TLS 不能即時重載，所以對它們不寫入這些設定。
- **覆蓋自訂值**：每次啟動 daemon 都用所選標的（沒選過就是 Paseo）的值寫入 relay、App 網址與 CORS 來源，所以切換標的（包含切回 Paseo）時，`config.json` 裡自訂的 relay 與 App 網址會被覆蓋；沒有切換、只是停止再啟動，也會被預設標的 Paseo 的值覆蓋。其他設定保留。
- **配對連結**：`<網頁 App>/#offer=…`，只放行所選標的的精確網址：Node 端檢查 App 網址、路徑 `/`、`#offer=` 片段，邀請必須是版本 2、帶 server ID 與金鑰、relay 端點是該標的的且為 TLS；Python 端再用 `connection.json` 的標的獨立檢查一次。Smart 標的若收到要求最低安全模式的邀請會回報 `PAIRING_SECURITY_UNSUPPORTED`（0.11.2 不會送出這種邀請，這只是防護）。邀請不寫入任何檔案。

| 代碼 | 意思與處理 |
|---|---|
| `CONFIGURATION_PENDING` | 已儲存的標的還沒套用。停止再啟動服務。 |
| `INVALID_TARGET` | 請求的標的不是三個 id 之一。 |
| `CONNECTION_STATE_CORRUPT` | `connection.json` 內容無法辨識。在插件頁重新選擇並儲存。 |
| `PAIRING_ORIGIN_INVALID` | daemon 給的連結不是所選標的的網頁 App。通常是 `config.json` 被手動改過；切換一次標的可重寫。 |
| `PAIRING_TARGET_MISMATCH` | 邀請的 relay 端點或 TLS 不是所選標的的。同上。 |
| `PAIRING_OFFER_INVALID` | 邀請無法解碼。 |
| `INVALID_PAIR_URL` | Python 端的獨立檢查拒絕了連結（網址或標的與 `connection.json` 不符）。 |

## 品牌識別補丁與升級

Woowtech Smart 與 Apporo Smart 的網頁 App 要求 daemon 的握手（`server_info`）帶有 `brand: {id, name}`；上游 Paseo 0.11.2 不送。作法與 Pi 的 Agent Connect 相同：以雜湊釘住的補丁在 `node_modules/@getpaseo/server/dist/server/server/websocket-server.js` 的 `status: "server_info",` 之後加一行 `brand: agentConnectBrand,`，檔首加一行 import，並在同一目錄放輔助檔 `hermes-paseo-brand-identity.mjs`。輔助檔讀取環境變數 `HERMES_PASEO_CONNECTION_TARGET`（未設定即 `paseo`，其他非三個 id 的值使 daemon 無法載入該檔而啟動失敗，這是故意的封閉式失敗）。

- 原檔 SHA-256 `ba8122d01dd17533231a573097ec4e9f91f4fd12caada107adb9f6706f5f8950`，補丁後 `7c4d2a764e2971da9cdcbc8c93cc5f467f632b04d55e1a3a8334abad8cd9abaf`。輔助檔檔名是本插件自己的，所以補丁後的雜湊與 Pi 插件的不同；以 Pi 的檔名做同樣的轉換，得到該插件的補丁雜湊，測試以此證明兩者是同一個轉換。
- **就地、不換版本**：補丁直接改已安裝的 runtime（`runtime/releases/0.11.2-r2-…`），沒有新的 revision 或目錄；`runtime/package.json` 與 `runtime/package-lock.json` 未動。「runtime 已就緒」仍然只看鎖定檔雜湊與 CLI 版本是 0.11.2，所以缺少補丁絕不會讓程式再執行 `npm ci`。
- **何時套用**：全新安裝在標記就緒之前就補好；已安裝但未補丁的 runtime（例如 rc.9 留下的）在 daemon 啟動前、持有 runtime 鎖、且確認沒有 daemon 從它執行時才補。執行中的 daemon 絕不會被這件事重啟，它保持沒有品牌的握手直到下一次停止再啟動。
- **安全**：先寫輔助檔（補丁後的檔案會 import 它），再以「暫存檔加 rename」寫入 `websocket-server.js`，兩個檔案的雜湊寫完後都再驗證，驗證失敗會把原檔放回；原檔雜湊未知、補丁後的檔案被改過、或路徑上任何一層是符號連結時一律拒絕，並且不改任何檔案（`BRAND_IDENTITY_SOURCE_MISMATCH`、`BRAND_IDENTITY_PATCH_MISMATCH`、`UNSAFE_SYMLINK`）。拒絕時 daemon 不會啟動。
- **檢查**：`sha256sum node_modules/@getpaseo/server/dist/server/server/websocket-server.js`（在該 release 目錄下）等於補丁後雜湊，且同目錄有輔助檔，表示已補丁。
- **相容 rc.9**：rc.9 判定 runtime 就緒只看鎖定檔雜湊與 CLI 版本，所以接受已補丁的 runtime。以 rc.9 啟動的 daemon 沒有 `HERMES_PASEO_CONNECTION_TARGET`，握手品牌是 `paseo`。

## PaaS 自動更新器與本版

本版不改 `host/` 的轉接檔（`dashboard_control.py`、`profile_lifecycle.py`、`resource_limits.py`、`hermes` 與其餘），`plugin.yaml` 只改 `version` 行，`package.json` 沒有相依套件，`runtime/package.json` 與 `runtime/package-lock.json` 與 0.1.4-rc.9 位元組相同；`git diff 1101a5d HEAD --stat -- host runtime bin` 沒有輸出可以重現這一點。所以更新器的 `host_adapter_changed`、`plugin_capabilities_changed` 與 `dependency_manifest_changed` 檢查不會擋這個版本。Hermes 原生安全掃描以本機的 Hermes v0.22.5 plugin-guard 對 rc.9 比對，沒有新增項目（見[驗收紀錄](validation.md)）；這是比對方式的模擬，不是更新器本身的執行結果。

**把 `v0.1.5-rc.1` 發佈成 Release 之前請先讀這一段：就目前的 CI 狀態，它會讓所有啟用自動更新的服務每天失敗一次。** 以下依 Hermes chart 0.4.9 的 `paseo-auto-update.py` 逐項核對：

- **哪一版會被選中。** 更新器的 `latest_release()` 取**版本最高的已發布 Release**：只排除 draft，**不看 pre-release 旗標**，以 `(主, 次, 修, 非 rc 為 1／rc 為 0, rc 編號)` 比較。`v0.1.5-rc.1` 是 `(0,1,5,0,1)`，高於 rc.9 的 `(0,1,4,0,9)`，所以一發佈成 Release（勾了 pre-release 也一樣），它就是每台服務下一個要評估的版本。
- **一定要五項檢查全綠。** `verify_release` 要求該 commit 上兩組 Unit tests、兩組 Browser 與 `Locked dependency audit` 各自最新一輪都成功。`Locked dependency audit` 目前是紅燈：`runtime/package-lock.json` 釘住 `hono` 4.13.13 與 `@hono/node-server` 2.1.4，`npm audit --omit=dev --prefix runtime` 回報 2 項 moderate（上游新公告；對 rc.9 的檔案樹結果相同），`main` 最近兩次的每週排程稽核也以同樣原因失敗。
- **失敗不計次數，所以不會停。** 檢查沒有全綠時更新器丟出 `release_checks_not_green`，這發生在 `record_failure` 之前，沒有重試上限：每台服務的每日更新 Job 與 `probe` **每天都會失敗**，而且什麼都不會安裝、daemon 也不會被重啟，直到有更高的版本出現。
- **用較低的 tag 救不了。** 版本較低的 tag 贏不了它；熱修補需要更高的版本號，而且那一版也必須通過稽核。把稽核修綠需要更新 `runtime/` 的鎖定檔，但鎖定檔與已安裝的那份不同時，`validate_candidate` 會以 `dependency_manifest_changed` 拒絕，所以那是 runtime 變更，要走另一條需要 chart 配合、凍結整批服務的發版流程。
- **只推 tag 更新器看不到。** 更新器只列出 Release，不列 tag。

**結論：在稽核轉綠、而且 chart 允許新的鎖定檔之前，只推 tag，不要發佈 Release。** 要在專用服務試用時，直接指定 commit 安裝（canary，不經更新器）：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin --ref <commit-sha> --force --enable
```

要發佈 Release，必須先修好 runtime 鎖定檔，並讓 chart 接受它，再讓五項檢查全綠。

更新前後 daemon 的行為：**自動更新器會重啟執行中的 daemon。** 在啟用 `paseoAutoUpdate` 的服務上，更新器對執行中的 daemon 依序做 `control stop`、`hermes plugins install … --ref <sha> --force --enable`、`control start`，所以 daemon 會以新版程式碼啟動一次；更新後 Dashboard 重載與 Plugin Doctor 檢查若不健康，它會裝回上一版並再 `control stop`、`control start`（以舊程式碼）。手動更新（Web／CLI 安裝、Git pull 並重載 Dashboard）才不會重啟仍在執行的 daemon。

這次由更新器發起的重啟，在本版**什麼都不會改變**：沒有人儲存過連線標的（沒有 `connection.json`）時，啟動與 0.1.4-rc.9 的啟動完全相同，不寫入 relay、App 網址或 CORS，不補丁 runtime，不備份，不刪檔，daemon 視為 Paseo，`config.json` 與 runtime 目錄位元組不變。連線標的與品牌補丁要等有人在插件頁儲存標的（Paseo 也算）之後的**下一次**停止再啟動才套用。若更新器因 Dashboard 或 daemon 不健康而自動裝回上一版，上一版（rc.9）接受已補丁的 runtime 與新版寫下的 `config.json`，見下節。

## 回滾到 0.1.4-rc.9

1. **先在插件頁切回 Paseo**：選 **Paseo**、儲存，按 **停止服務** 再 **恢復服務**，確認畫面沒有「標的已儲存…」的提示，產生的配對連結是 `app.paseo.sh`。
2. 再降到 0.1.4-rc.9（Git 切換或更新器回滾）。rc.9 接受已補丁的 runtime、不會重新安裝；新版寫下的 `config.json`（app、relay、CORS）rc.9 照原樣保留，且是 0.11.2 設定檔接受的內容。
3. 若沒有先切回 Paseo：rc.9 的 daemon 仍會啟動，但 rc.9 只放行 `app.paseo.sh` 的配對連結，所以在 Smart 標的下它會拒絕產生配對連結（`PAIRING_ORIGIN_INVALID`）。補救方式是重新升到 0.1.5-rc.1、切回 Paseo、停止再啟動，然後再降版。
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
2. 變更 `host/`、`plugin.yaml` 能力或新增相依套件的版本不會被自動安裝，需要另外發 chart／HA 映像。0.1.5-rc.1 的檔案不屬於這一類，但發佈成 Release 會被稽核紅燈擋下並每天失敗，見下面[本版的說明](#paas-自動更新器與本版)。
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
