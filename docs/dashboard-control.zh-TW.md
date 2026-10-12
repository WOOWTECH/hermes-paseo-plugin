# 在 Hermes 內重載 Dashboard

v0.1.3 的 Paseo 頁提供「重載 Dashboard → 確認重載」。主機端確認請求後，只結束目前的 Dashboard 程序，由原來的 s6 supervisor 重新啟動。頁面等待新的伺服器識別及可用的插件 API，再自動重新整理目前頁面。

此按鈕需要主機端一次性部署 `host/` adapter。普通 Hermes 插件安裝不會自行改寫主機 CLI 或取得管理權限；沒有 adapter 時按鈕會停用並顯示原因。首次安裝插件時，即使插件 API 還是 404，準備好的主機也可以使用此按鈕。

## 主機需求

- Hermes 0.19 的 FastAPI Dashboard 與原有登入保護。
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

若工作負載設定 `fsGroup`，Kubernetes 重新掛載可能把 profile 的私有檔案由 `600` 改成 `660`，導致 Origin 等私有設定被拒絕。對於已存在且 `/opt/data` 由 Hermes UID 10000 擁有的 s6 部署，可加 `--preserve-private-profile`；安裝器先驗證正在運行的所屬 Pod 與目錄 UID，再移除這一台工作負載的遞迴 fsGroup 權限改寫。仍由原映像維持服務帳戶的目錄所有權，私有檔案驗證不會放寬。若已被改寫，需用服務帳戶重新執行 Origin 設定命令；正式 chart 也需保留這項設定。

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
