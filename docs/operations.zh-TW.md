# 維運與可重複驗收

本頁適用 Linux、單一 Hermes profile、受管 Paseo 0.17.4 runtime（0.2.0-rc.1 起；0.1.4 各版為 0.11.2）。先在專用測試服務執行；測試會建立真實模型對話並使用帳號額度。模型名稱以該 Hermes 帳號的實際清單為準。

## 備份內容與還原範圍

Paseo 插件資料位於 `$HERMES_HOME/plugin-data/hermes-paseo`。可重建的 npm runtime 與語音模型快取不等於對話資料；保留快取可以縮短恢復時間，但不能拿快取當備份。

這次實測備份包含：

- `state.json`、`onboarding.json`、`dashboard-origin.json`、`host-lifecycle.json`。
- 若存在，包含 `pairing.private.json`、`preferences.json`、`acceptance-job.json`、`connection.json`（0.2.0-rc.1 起的連線標的）。
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

## 驗證官方 relay 迴路

Dashboard 啟動流程在 daemon 就緒後會自動做一次（從未驗證或上次成功已超過 24 小時才做，失敗不影響配對與對話）。啟動流程由使用者開啟 Paseo 頁面觸發，Pod 重啟或 PaaS 自動更新後不會自動重做；需要最新結果時可以隨時手動重做，不需要瀏覽器，也不會呼叫模型：

```bash
node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" relay <<< '{}'
```

回傳的 `daemon.relayVerified` 與 `relayVerifiedAt` 就是結果；失敗時輸出 `{"ok":false,"code":"RELAY_UNVERIFIED"}` 並以非零結束。常見原因是 Pod 不能出站連到所選標的的 relay（`relay.paseo.sh:443`、`relay.woowtech.io:443` 或 `relay.apporo.ai:443`）、daemon 的 relay 被設定關閉，或該 relay 暫時不可用。這個檢查只證明 relay 到本 daemon 的路徑；要確認使用者端能用，仍須從所選平台的官方網頁實際配對一次。

0.2.0-rc.1 起，檢查使用所選標的的配對邀請：用戶端從邀請讀取 relay 位址與 TLS，與官方網頁的連線方式相同。新標的等待套用時回傳 `CONFIGURATION_PENDING`，不留紀錄；驗證紀錄會註明標的，切換標的後舊紀錄不再算數。

## 發佈新版與 PaaS 自動更新

啟用 Hermes chart 的 `paseoAutoUpdate`（0.4.3 起含回滾）的 PaaS 服務，每天在排程時間檢查本 repo **版本號最高的已發布 release**（`latest_release()`：只排除草稿，預發布也算；見下方的[艦隊凍結警告](#艦隊凍結警告不要為-020-rc1-建立-github-release)），符合以下全部條件才安裝；任何一項不符就拒絕（Job 顯示失敗，外掛不動）：

- release 的 commit 在 `main` 上，且 `Unit tests`、`Browser`（各兩組）與 `Locked dependency audit` 五項檢查**每項最新一輪**都成功。
- `host/` 的四個主機轉接檔逐位元組不變；`plugin.yaml` 除 `version` 行外不變，且 `version` 等於 tag；`package.json` 沒有相依套件。
- Hermes 原生安全掃描沒有新增項目（以 pattern、severity、category、檔案、說明比對，不含行號；同檔同模式多出一處仍會被擋）。

發 release 時請注意：

1. **tag 一推就會再跑一輪 CI**（約 1–2 分鐘；Chromium 安裝偶爾卡住，要重跑）。這段時間排程剛好執行，會因為檢查還沒全綠而拒絕，不計入失敗次數，隔天再試。要立刻更新時，先等這一輪綠燈。
2. 變更 `host/`、`plugin.yaml` 能力、新增相依套件，或變更 `runtime/package.json`／lockfile 的版本不會被自動安裝（後者回報 `dependency_manifest_changed`），需要另外發 chart／HA 映像或由管理者協調。0.2.0-rc.1 把 Paseo 升到 0.17.4，屬於最後一種。**這類閘門失敗不計入失敗次數**，後果見下節。
3. 更新後若重載的 Dashboard、daemon 或 Plugin Doctor 不健康，更新器會自動裝回上一版、重啟 daemon 並再重載一次，Job 仍標示失敗以便察覺；失敗的版本只重試一次，之後要等更新的 release。
4. 多台服務各自排程、互不把關。要先在專用服務驗證時：暫停其他服務的 CronJob（`spec.suspend: true`），在專用服務以 `kubectl create job --from=cronjob/<名稱>` 手動執行並驗證，通過後再逐台執行並恢復排程。rc.6 就是這樣發佈的。

### 艦隊凍結警告：不要為 0.2.0-rc.1 建立 GitHub Release

PaaS 更新器（chart 0.4.9 的 `charts/hermes-agent/files/paseo-auto-update.py`）每天取**版本號最高的已發布 GitHub Release**：`latest_release()` 列出本 repo 的 releases，排除草稿（draft）與沒有發布時間的項目，只認 `vMAJOR.MINOR.PATCH` 或 `vMAJOR.MINOR.PATCH-rc.N` 形式的標籤，**預發布（pre-release）一樣算**，再取版本號最大者。它不會「挑通過閘門的最新版」，也不會往下找較舊的版本。後果：

- 本版改了 `runtime/package-lock.json`，在 `validate_candidate` 以 `dependency_manifest_changed` 失敗（`runtime/package.json` 與 lockfile 必須與已安裝版本逐位元組相同）。
- 閘門失敗發生在安裝之前，**不計入失敗次數**：失敗次數（`failed_attempts`，達 2 次就跳過該版本）只在安裝或健康檢查失敗時累加。所以每個啟用 `paseoAutoUpdate` 的服務，CronJob 每天都對同一個版本失敗，不會「重試一次後放棄」。
- 因為永遠取最高版本，之後的 0.1.x 熱修（例如 `v0.1.5`）的版本號比 `v0.2.0-rc.1` 低，**永遠不會被評估或採用**。整個艦隊被凍結在 rc.9：Job 每天失敗，連安全修補也進不去。

在 chart／更新器接受新 runtime 之前（放行 `runtime/` 變更，並依下節給 `prepare`、`stop` 足夠的時間）：

- **只推 git tag，不建立 GitHub Release**。沒有 Release 的 tag 不在 releases 清單中，更新器看不見（草稿同樣看不見）。也可以先不打 tag，以 commit SHA 做 canary。
- 若已經誤發：把該 Release 改回草稿或刪除它（不必刪 tag）；更新器下一次執行就回到原本的最高版本，不需要其他處理。
- 要在專用服務驗證時，手動安裝指定的 commit（更新器自己也是用這個指令安裝已驗證的 commit）：

  ```bash
  hermes plugins install WOOWTECH/hermes-paseo-plugin --ref <commit SHA> --force --enable
  ```

  `--force` 覆蓋的是插件目錄 `plugins/hermes-paseo`；狀態與 daemon 資料在 `plugin-data/hermes-paseo`，不在其中。裝完重載 Dashboard：舊 daemon 繼續服務，背景自動準備新版；確認狀態的 `installed` 與 `configCheck.ok` 後，結束使用中的對話，再按「停止服務」與「恢復服務」。更新器的帳本記錄了已安裝的 commit，手動換成別的 commit 之後，它會回報 `installed_revision_drift`（Job 失敗，但不改動外掛）；所以請在**沒有啟用更新器**的服務做 canary，或先暫停該服務的 CronJob（`spec.suspend: true`），做完再裝回原本的 commit。

### 更新器的時間限制

更新器的 `control()` 對每個動作（`status`、`start`、`stop`，日後也包括 `prepare`）整體只給 **45 秒**，逾時就殺掉該次 `node bin/control.mjs`。這對 0.17.4 有兩個影響：

- **停止**：0.17.4 停止時最多等 worker 約 10 秒、每個終端機約 5＋3 秒，再加上等待 supervisor 結束（插件上限 45 秒）；整個 `control stop` 的總時間可能超過 45 秒而被更新器砍掉。被砍時 Job 失敗、`pending` 留在帳本；下次執行的 `reconcile` 若發現 daemon 沒在執行會重新啟動它，但更新沒有套用。
- **準備與啟動**：首次下載約 400 MB，`prepare`（上限 480 秒）與 `start` 都放不進 45 秒。更新器要先改成給 `prepare` 至少 480 秒、給 `stop` 至少 60 秒（建議與橋接層一致的 120 秒），才適合放行本版。

## 0.2.0-rc.1 升級、退回與 Paseo 0.17.4

### 升級路徑

插件在新版本目錄 `runtime/releases/0.17.4-r1-09cdbfab2022` 安裝 0.17.4，不覆寫舊目錄。daemon 一律由啟動它的版本目錄控制：0.1.4 啟動的 0.11.2 daemon，狀態、配對、設定重新載入與停止都經由 `0.11.2-r2-71709cd7872f`（或 0.1.2–0.1.3 的 `0.11.2-r1-55efbfec4437`）自己的模組。只有程序環境裡的 `HERMES_PASEO_RUNTIME_REVISION` 恰好是這兩個已知版本才會交給 0.11.2；沒有記錄或不認識的版本一律用本版處理。插件從不同時啟動兩個 daemon：`paseo daemon start` 遇到仍在執行的 supervisor 會沿用它，插件也不會把它記成本版。

- **PaaS**：目前的更新器會以 `dependency_manifest_changed` 拒絕本版，Job 失敗但服務不動。日後若以 chart／更新器變更或管理者手動安裝放行，流程是「舊版程式停止 0.11.2 → 安裝 → 新版程式啟動 0.17.4」：新程式看不到舊 daemon，直接全新安裝並啟動。注意更新器對 `control start` 只等 45 秒，而首次下載 0.17.4 約 400 MB（本機冷快取約 14 秒，PaaS 網路未測）；逾時時更新器會裝回舊版並重新啟動 0.11.2，被中斷的 `npm ci` 可能留在背景完成，隔天重試會用到 npm 快取。
- **HA 或手動更新**：Git pull 後重載 Dashboard，舊 daemon 繼續服務，頁面顯示「需要重新啟動」並註明目前執行 0.11.2。插件在背景安裝 0.17.4（手動停止時不會；失敗會重試，見下），並用 0.17.4 的讀取器在記憶體中檢查 `config.json`；這與手動執行 `control.mjs prepare` 相同（見下節）。結束對話後按「停止服務」再按「恢復服務」完成升級；重啟附加元件也會讓 daemon 以新版啟動。
- **準備失敗**：背景準備（`prepare`）失敗時（離線、磁碟不足、npm 逾時），頁面顯示「新版準備失敗」與原因代碼（`RUNTIME_INSTALL_FAILED`、`INSUFFICIENT_DISK`、`RUNTIME_INSTALL_TIMEOUT` 等），不是「啟動失敗」，也不建議停止：舊版 daemon 照常服務，階段維持 `running`。橋接層沿用啟動失敗的退避重試（30、60、120、300、600、900 秒，最後一個值重複，最多 8 次；用完後不再自動重試）；按「立即重試準備」（等同恢復服務）會立刻重試並重設計數。狀態的 `prepare` 欄位帶 `stage`（`ready`、`pending`、`running`、`failed`）、`code`、`retryInSeconds`（次數用完時為 `null`）；磁碟不足時另帶 `requiredMiB` 與 `availableMiB`。
- **停止不會讓 Paseo 停機**：新版尚未安裝並驗證時，把舊版 daemon 換成新版的停止（Dashboard 的「停止服務」）會被拒絕（`RUNTIME_NOT_READY`，HTTP 412）：daemon 與配對不變、不留下暫停。在準備期間排隊的停止，輪到它時若準備失敗也不會執行（同樣被拒絕並解除暫停）；準備成功則照使用者的要求停止。Hermes 的停用／移除，以及 `/paseo stop`、`paseo_stop`，不受這項限制（它們不是要換成新版）。
- **設定檢查**：`config.json` 先經過目標版本自己的 `readPersistedConfig`（0.17.4 會把舊的語音、`providers.openai` 設定整理成新格式）再合併插件管理的欄位，最後以 0.17.4 的嚴格結構驗證。讀不進來時回報 `CONFIG_INCOMPATIBLE` 且不改寫檔案；若此時使用者在 Dashboard 按「停止服務」要停止舊版 daemon，停止會被拒絕，避免 Paseo 停下後起不來。**插件的停用／移除不受這項檢查影響**，處理方式見下節。
- **磁碟需求**：安裝期間約 **1.5 GB** 可用（npm 下載快取約 0.4 GB 加解開後約 1.1 GB），完成後約 **0.75 GB**，另外舊版 runtime（0.11.2 r2 實測約 0.8 GB）在新版 daemon 啟動並裁剪前仍在碟上。PaaS chart 的預設資料碟是 5 GiB，且與 Hermes 自己的資料共用，空間很緊；要在這種服務上升級，先確認資料碟用量。
- **安裝前檢查**：可用空間低於 1536 MiB 時以 `INSUFFICIENT_DISK` 拒絕，沒有建立任何目錄、沒有啟動 npm，舊版 daemon 與它的 runtime 完全不動。`status` 的 `prepare` 欄位帶 `{"state":"failed","code":"INSUFFICIENT_DISK","requiredMiB":1536,"availableMiB":…}`（只有數字，沒有路徑）；清出空間後下一次 `prepare` 或啟動就會安裝。讀不到可用空間的檔案系統不擋安裝。
- **安裝後清理**：npm 的快取放在新版本目錄內的暫存目錄（不是持久的 HOME），安裝成功或失敗都移除；glibc 主機另外移除用不到的 `node_modules/@anthropic-ai/claude-agent-sdk-*-musl`（每版約 340 MB，非 glibc 主機不動）。就緒判斷與收據不依賴這些目錄。
- **失敗與中斷的安裝**：任何失敗（`RUNTIME_INSTALL_FAILED`、`RUNTIME_INSTALL_TIMEOUT`、安裝中途空間用盡的 `INSUFFICIENT_DISK`、版本或品牌修補驗證失敗）都會整個移除該版本目錄；被強制中止而留下的目錄沒有收據，下一次安裝會先整個丟棄再從零開始。只有空目錄或帶本插件 runtime 清單的目錄才會被刪除，連結與他人的目錄一律拒絕（`RUNTIME_NOT_OWNED`）；若仍有 daemon 以這個版本目錄執行則不碰它（`RUNTIME_IN_USE`）。
- **裁剪與退回**：本版 daemon 成功啟動後，刪除沒有 daemon 使用的 `0.11.2-r1-*`；最新的 `0.11.2-r2-*` 只在裁剪後仍有約 3 GiB（3072 MiB）可用空間時保留供退回，否則一併刪除，之後退回 rc.9 會重新下載舊版 runtime（約 400 MB）。只刪除有自己收據的確切目錄，不跟隨連結。

### 預先準備新版：`prepare`

`prepare` 在不停止、不啟動、不重載任何 daemon 的前提下，安裝並驗證本版 runtime，再用本版自己的讀取器檢查目前的 `config.json`；舊版 daemon 繼續服務。這是升級的第一步：Dashboard 在背景使用它，PaaS 更新器日後也應在停止舊版 daemon 之前先呼叫它。

```bash
node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" prepare <<< '{}'
```

- **輸入**：沒有（`{}`；多餘欄位以 `INVALID_REQUEST` 拒絕）。`bin/control.mjs` 與其他動作走同一個入口，沒有另外的指令檔。
- **冪等**：已安裝並驗證的版本只做核對，不下載、不取得 runtime 鎖，也不重寫 `config.json`。只有安裝期間持有鎖，所以配對、設定儲存與狀態讀取不會因為安裝而被擋住；若別的啟動或準備正在安裝，最多等 120 秒，之後版本已就緒就直接回報。
- **結束行為**：安裝並驗證成功時結束碼為 0，輸出公開狀態（同 `status`），其中 `installed` 為 `true`，`configCheck` 是設定檢查結果：`{"ok":true,...}`，或 `{"ok":false,"code":"CONFIG_INCOMPATIBLE"}`、`{"ok":false,"code":"CONFIG_CORRUPT"}`。**設定不相容不是失敗**：結束碼仍為 0，檔案不改寫，呼叫端必須自己讀 `configCheck.ok`，為 `false` 就不可停止舊版 daemon。安裝或驗證失敗時結束碼為 1，輸出 `{"ok":false,"code":"..."}`（例如 `NPM_UNAVAILABLE`、`NODE_VERSION_UNSUPPORTED`、`RUNTIME_BUSY`、`INSUFFICIENT_DISK`、`RUNTIME_INSTALL_FAILED`、`RUNTIME_INSTALL_TIMEOUT`、`RUNTIME_IN_USE`），沒有留下看起來已就緒的半成品，舊版 daemon 沒有被動過；失敗的細節可再用 `status` 的 `prepare` 欄位讀取。
- **時間**：npm 安裝上限 300 秒，加上最多 120 秒等鎖與數秒驗證；橋接層對 `prepare` 的上限是 480 秒。呼叫端請至少給 480 秒。PaaS 更新器現有的 `control()` 對每個動作只給 45 秒，首次下載約 400 MB 可能放不進去，日後的更新器需要為 `prepare` 另設逾時。
- **更新器建議順序**：`prepare` → 結束碼 0、`installed` 與 `configCheck.ok` 皆為 `true` → 停止舊版 daemon → 安裝新版插件 → 啟動。任何一項不符就在停止之前中止，Paseo 不會因此停機。

### 設定不相容：停止被拒絕與處理方式

新版 runtime 讀不進目前的 `config.json`（`CONFIG_INCOMPATIBLE`，或 JSON 本身壞掉的 `CONFIG_CORRUPT`）時，Paseo 若在使用者按下「停止服務」後停下，就會起不來。所以：

- **會被拒絕的停止**：Dashboard 的「停止服務」（用來把舊版 daemon 換成新版）。回應 HTTP 412 與代碼，daemon 繼續執行，**不留下暫停**：`enabled` 維持 `true`，配對與容器重啟後的自動恢復都不受影響。若這個停止是在背景啟動或準備期間排隊的，輪到它時才被拒絕，狀態會帶 `stopRefused`（代碼與時間），頁面據此結束等待並說明。
- **不會被拒絕的停止**：Hermes Web 的停用與移除（主機轉接檔呼叫 `call('stop', {})`，橋接層會對執行環境送出 `{"reason":"disable"}`，不做任何升級檢查，daemon 一定被停止）；`/paseo stop`、`paseo_stop` 工具（文件上的「停用前先停止」）也是同一種。直接用 CLI 時，`control.mjs stop` 預設會檢查，輸入 `{"reason":"disable"}` 才會略過。
- **找出是哪個設定**：頁面「需要修正設定」卡片列出不相容的設定**路徑**（例如 `daemon.keepAliveSeconds`），只有鍵的路徑，不含任何值。命令列可讀同一份清單：

  ```bash
  node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" status <<< '{}'
  ```

  `configCheck` 是 `{"ok":false,"code":"CONFIG_INCOMPATIBLE","paths":["..."]}`；`CONFIG_CORRUPT` 表示 JSON 本身無法解析（沒有路徑可列）。
- **設定檔位置**：`$HERMES_HOME/plugin-data/hermes-paseo/daemon/config.json`。PaaS 與 HA 映像的 `HERMES_HOME` 預設為 `/opt/data`，所以是 `/opt/data/plugin-data/hermes-paseo/daemon/config.json`；也就是 Paseo 的 `PASEO_HOME` 底下的 `config.json`。
- **修正**：先備份這個檔案，再用文字編輯器移除或改正頁面列出的路徑（從 0.11.2 留下、0.17.4 不認得的鍵直接刪除即可；Paseo 之後會自己把檔案整理成新格式）。daemon 執行中時編輯這個檔案不會重啟它。頁面讀取狀態時會重新檢查，修正後約數秒內「需要修正設定」就會消失，再按「停止服務」與「恢復服務」完成升級。
- **不想修正時**：直接停用或移除插件（Hermes Web 不受影響），或在不更新插件的情況下保留舊版 daemon 繼續服務。重啟附加元件或 Pod 並不能繞過：舊版 daemon 隨容器結束，下一次啟動仍會因為同樣的設定失敗。

### 退回 0.1.4-rc.9

已在隔離環境實測：rc.9 的程式可以停止 0.17.4 daemon，並以 0.11.2 在同一個 `PASEO_HOME` 重新啟動（使用 0.17.4 寫入的 `config.json`），server ID 與金鑰保留。限制：

- 0.17.4 會把代理紀錄的 `config.featureValues` 改寫成 `controls`；退回後 0.11.2 讀不到這些代理選項（例如思考等級），需要在對話中重新選擇。
- 選了 Smart 標的後退回：0.11.2 仍會連到該標的的 relay 並可啟動，但 rc.9 只接受 `app.paseo.sh` 的配對連結（`PAIRING_ORIGIN_INVALID`），Smart App 也會因缺少品牌宣告而拒絕。退回前先切回 Paseo 並停止再恢復一次。
- 0.17.4 期間若有 Paseo 用戶端寫入 0.11.2 不認得的設定（例如 `daemon.relay.requireProtectedSecurity`、`daemon.usage`、`agents.idleRuntimeCleanup`），0.11.2 會以 `CONFIG_INVALID` 拒絕，須先移除該設定。插件自己不寫入這些鍵。

### 0.17.4 的新預設

插件保留以下上游預設，不寫入設定：寫入後退回 rc.9 時，0.11.2 的嚴格設定會拒絕整個檔案。

- `agents.idleRuntimeCleanup`（預設開啟）：閒置 60 分鐘的代理執行環境會被關閉，下次訊息時重新啟動並接續，與冷啟動後續聊相同。
- `daemon.usage.enabled`（預設開啟）：內建的 Claude／Codex 用量來源會讀取服務帳戶 HOME 下的 `~/.claude/.credentials.json`、`~/.codex/auth.json`，並呼叫 Anthropic／ChatGPT 的用量 API。0.11.2 已內含這兩個來源，只是沒有開關；Hermes 容器未安裝或未登入這兩個 CLI 時不會讀到憑證。需要關閉時可在 Paseo 設定調整，退回 rc.9 前要移除。

### 停止、終端機與 procps

0.17.4 停止時會等待 worker（最多約 10 秒），並逐一關閉終端機 worker（每個約 5＋3 秒），清理在 supervisor 結束前後各進行一次，需要 procps 的 `ps` 讀取程序表；讀不到時不送出任何訊號，終端機 shell 可能留下。PaaS 與 HA 映像都建在 Hermes v0.22.5 官方映像上，其 Dockerfile 安裝 procps（依 Dockerfile 推定，未在執行中的容器確認；更早的映像未確認）。

插件等待 supervisor 結束的上限為 45 秒，bridge 對整個停止操作的上限為 120 秒。supervisor 已結束並釋放 PID lock、只剩終端機清理未確認（`TERMINAL_CLEANUP_NOT_CONFIRMED`）時，停止視為完成並在狀態記下警告，下次停止會再清理。終端機 worker 的 socket 位於 `$TMPDIR/paseo-<uid>/`。

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
