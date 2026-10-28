# 維運與可重複驗收

本頁適用 Linux、單一 Hermes profile、受管 Paseo 0.11.2 runtime。先在專用測試服務執行；測試會建立真實模型對話並使用帳號額度。模型名稱以該 Hermes 帳號的實際清單為準。

## 備份內容與還原範圍

Paseo 插件資料位於 `$HERMES_HOME/plugin-data/hermes-paseo`。可重建的 npm runtime 與語音模型快取不等於對話資料；保留快取可以縮短恢復時間，但不能拿快取當備份。

這次實測備份包含：

- `state.json`、`onboarding.json`、`dashboard-origin.json`、`host-lifecycle.json`。
- 若存在，包含 `pairing.private.json`、`preferences.json`、`acceptance-job.json`。
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

Dashboard 啟動流程在 daemon 就緒後會自動做一次（從未驗證或上次成功已超過 24 小時才做，失敗不影響配對與對話）；也可以隨時手動重做，不需要瀏覽器，也不會呼叫模型：

```bash
node "$HERMES_HOME/plugins/hermes-paseo/bin/control.mjs" relay <<< '{}'
```

回傳的 `daemon.relayVerified` 與 `relayVerifiedAt` 就是結果；失敗時輸出 `{"ok":false,"code":"RELAY_UNVERIFIED"}` 並以非零結束。常見原因是 Pod 不能出站連到 `relay.paseo.sh:443`、daemon 的 relay 被設定關閉，或 Paseo 官方 relay 暫時不可用。這個檢查只證明 relay 到本 daemon 的路徑；要確認使用者端能用，仍須從官方 Paseo 頁面實際配對一次。

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
