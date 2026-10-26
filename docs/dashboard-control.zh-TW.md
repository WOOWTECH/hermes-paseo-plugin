# 在 Hermes 內重載 Dashboard

Paseo 頁提供「重載 Dashboard → 確認重載」。主機端確認請求後，只結束目前的 Dashboard 程序，由原來的 s6 supervisor 重新啟動。頁面等待新的伺服器識別及可用的插件 API，再自動重新整理目前頁面。0.1.4 的主機介面另管理無瀏覽器時的啟動恢復及原生 Web 停用／移除前的服務停止。

此按鈕需要主機端一次性部署 `host/` adapter。普通 Hermes 插件安裝不會自行改寫主機 CLI 或取得管理權限；沒有 adapter 時按鈕會停用並顯示原因。首次安裝插件時，即使插件 API 還是 404，準備好的主機也可以使用此按鈕。

## 主機需求

- Hermes 0.19／0.22 的 FastAPI Dashboard 與原有登入保護；發版驗證以實測矩陣為準。
- 單一 Hermes profile、s6 supervision；服務路徑 `/run/service/dashboard`。
- CLI 位於 `/opt/hermes/.venv/bin/hermes`，Python 位於同一 venv。
- 以 Hermes 服務帳戶啟動 Dashboard，保留原映像的 privilege-drop shim。
- `HERMES_DASHBOARD_PUBLIC_URL` 設成正式 HTTPS 網址；此值是 Origin 驗證依據。

## Kubernetes 主機準備

管理者在此 repo 執行下列命令。將三個參數換成自己的 context、namespace 與 StatefulSet。

```bash
python3 bin/install-dashboard-control-k8s.py \
  --context YOUR_CONTEXT \
  --namespace YOUR_NAMESPACE \
  --workload YOUR_HERMES_STATEFULSET
```

預設只讀取指定工作負載，列出準備套用的 patch。確認後，在同一命令加 `--apply`。這會新增唯讀 ConfigMap 掛載，並觸發這一台 Hermes 的 rollout；等待工作負載就緒，再使用 Dashboard。

掛載會跨 Pod 重啟保留。Helm 升級／重新部署可能重建工作負載並移除額外掛載：正式部署需將相同 volume/mount 納入 chart／部署模板，或在部署完成後重新執行這個安裝命令。不要只靠一次手動 patch 宣稱所有平台 redeploy 均已支援。

### 正式 chart 整合狀態

`hermes-agent` chart `0.4.0` 已發布至平台 Gitea Helm 與 OCI registry，提供選用式 `paseoDashboardControl` 掛載支援，預設停用；管理者指定由自己維護的現有 ConfigMap，chart 固定掛載四個 adapter 檔案與 CLI wrapper。完整 chart 倉庫 CI 已通過，兩個 channel 重新下載的套件完全相同，26 個檔案的 SHA-256 均符合驗證候選。2026-10-26 已在 PaaS `.263` 以原生 Redeploy 部署到專用測試服務，Helm 從 revision 2／chart 0.3.13 升為 revision 3／chart 0.4.0，實際掛載及原配對對話均通過驗證。

`0.4.0` 的服務 values 形狀如下；舊版 `0.3.13` 不支援此設定，必須一併更新服務的目標 chart 版本：

```yaml
paseoDashboardControl:
  enabled: true
  existingConfigMap: YOUR_REVIEWED_ADAPTER_CONFIGMAP
```

正式啟用需要同時保留已發布的新 chart 版本、服務專用 values，以及同 namespace 的 adapter ConfigMap。不能只把值寫入資料庫就宣稱部署完成；必須經平台實際 Redeploy 後重新驗證掛載、Dashboard 重載及模型對話。

### 部署前比對與服務專用版本

部署前應以平台當下組裝的服務設定進行 `helm upgrade --dry-run=server`，並比對運行中的工作負載。不要直接沿用 `helm get values` 作為完整設定：實測中，磁碟已擴容且平台已保存 `10Gi`，舊 Helm revision 仍記錄 `5Gi`；Pod 上手動加入的 CPU 執行緒限制也未出現在平台設定中。已將該測試服務既有的三個限制保存到其 `extraEnv`，保留其他設定，沒有觸發重啟。不同服務應依自己的 CPU 額度設定，不能照抄測試機的數字；合併 `extraEnv` 時保留原有項目。

2026-10-25 的新版 chart 伺服器 dry-run 通過 22 項比對，包括映像、環境變數、資源、安全設定、健康檢查、原 PVC、10 GiB 設定、兩個唯讀掛載、四個 adapter 檔案與模式。Helm revision 及運行中的 Pod template 均未改動。這是候選設定驗證，尚非實際升級。

平台須保存「期望的 chart 版本」及必要的映像 pin，再執行 Redeploy。`helm_chart_version` 是已部署版本的紀錄，不能修改它來假裝已固定目標版本。2026-10-26 正式平台已升為 `.263`，具備此功能；測試服務使用 `deployment_policy=pinned`、`deployment_chart_version=0.4.0`，並以 `deployment_image_overrides` 固定原本已驗收的 Hermes 映像。共用商品範本在這段期間已更換預設映像，因此此固定也實際驗證了 Redeploy 不會把測試服務換成範本的新映像。

管理者應依序完成：確認同 namespace 的 adapter ConfigMap 與內容、保存服務專用 chart／映像 pin、合併上述 values 與原有 `extraEnv`／磁碟設定，再透過平台原生 Redeploy 部署。部署後同時核對期望版本、實際 Helm 版本、Pod 的 imageID、掛載及平台最終 Running 狀態。此次實測也確認 10 GiB、三個 CPU 執行緒限制、fsGroup、模型登入及配對金鑰保留，並完成原對話記憶續聊。不要為一台測試服務改動所有租戶共用的商品範本。

若工作負載設定 `fsGroup`，Kubernetes 重新掛載可能把 Origin 檔案從 `600` 改成 `660`。0.1.4 保留平台所需的 `fsGroup`，在 Dashboard 啟動時只修復服務帳戶擁有、無 symlink／hardlink、內容與正式 `HERMES_DASHBOARD_PUBLIC_URL` 一致的 Origin 檔案及其專用目錄。其他私有檔案及錯誤 Origin 不會被自動信任或改寫。舊的 `--preserve-private-profile` 參數保留作目錄 UID 驗證，相容既有部署命令，但不再移除 `fsGroup`。

已啟用插件在主機啟動時自動準備 runtime；已啟用的服務意外中斷時，在 Dashboard 受管程序內恢復，不需要開啟瀏覽器。使用者手動停止的狀態仍保留。從 Hermes Web 停用或移除此插件時，主機會先停止其擁有的 Paseo daemon，再讓原生操作繼續；停止尚未確認時回傳錯誤，保留插件來源供重試。從 CLI 移除仍須先執行 `/paseo stop`。

主機 CLI wrapper 會依 Linux cgroup 的 CPU quota 及 CPU affinity，設定本機 llama.cpp／OpenMP 的預設執行緒數，避免以整台節點的核心數壓滿小型容器。HTTP 執行緒預設最多 8；已明確設定的 `LLAMA_ARG_THREADS`、`LLAMA_ARG_THREADS_BATCH`、`LLAMA_ARG_THREADS_HTTP`、`OMP_NUM_THREADS` 會保留。這些限制適用於經 wrapper 啟動並繼承環境的程序；其他入口的模型服務仍須配置自己的資源限制。

## 建入 s6 映像

也可用 `host/Dockerfile` 將 adapter 建入相容的原映像：

```bash
docker build --build-arg HERMES_BASE_IMAGE=YOUR_PINNED_S6_HERMES_IMAGE \
  -f host/Dockerfile -t YOUR_HERMES_WITH_DASHBOARD_CONTROL host
```

原有 `hermes` CLI 除 `dashboard` 外仍直接呼叫 Hermes 原生 `main()`，ACP 及其他子命令沿用既有實作。

## 操作與限制

- 重載需要明確確認，不會在插件載入、安裝失敗或頁面更新時自動觸發。
- 請求使用 Dashboard 原有登入，拒絕跨 Origin、跨 profile query、額外參數和過大 body。
- 主機只驗證並 signal 自己的 Dashboard PID，沒有任意 shell、PID、檔案路徑或 Kubernetes 操作入口。
- 重載會短暫中斷 Dashboard；已儲存的 profile 設定、Paseo 狀態與對話資料保留。
- 重複點擊只會接受一次；斷線後先觀察，不會自動再送重載。
- 超過 60 秒仍未確認成功，頁面顯示未完成，保留可檢查的狀態，不宣稱重載成功。
- 多 profile、systemd、非 s6 映像與其他 CLI 位置不在此 adapter 的支援範圍。

## 與 Restart Gateway 的差異

安裝或更新此插件的 Dashboard 後端時，使用 Paseo 頁的「重載 Dashboard」。該操作已在真實 s6 主機驗證，不需要跳至 PaaS。原生頁面的「Restart Gateway」會重新載入 Gateway／工具處理程序，屬於另一個操作；必須查看該工作最後的退出狀態，收到「已啟動」不代表重啟完成。

2026-10-25 的 Hermes 0.22.5 測試映像曾缺少 PM 已登記的依賴環境，原生 Gateway 重啟回報 `no dependency environment is committed`。在獲授權擴至 10 GiB 後，以官方 `hermes pm repair` 沿用原依賴清單修復，原生 Gateway 重啟及容器重建後的 ACP 連線已通過。這是既有主機環境修復，插件不會自動擴容或改寫 Hermes 核心。

遇到同樣訊息，管理者應先確認儲存空間，再以相同服務帳戶、相同 profile 執行官方修復。該映像的 5 GiB 磁碟容納不了修復快照；10 GiB 是此測試組合的實測容量，不是任意模型／映像的容量保證。修復完成後重啟 Hermes，再查看 Gateway 工作的最終退出狀態及實際連線。不要把接受請求當成程序已換新，也不要手動刪除失敗修復標記來跳過檢查。
