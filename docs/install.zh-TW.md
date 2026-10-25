# Hermes Paseo：下載、安裝、部署與測試

適用於 v0.1.3 公開預覽版。本教學將插件部署到已有的 Hermes Agent / Dashboard；Hermes 核心與模型帳號須先準備好。

## 下載網址

- 原始碼：https://github.com/WOOWTECH/hermes-paseo-plugin
- v0.1.3：https://github.com/WOOWTECH/hermes-paseo-plugin/releases/tag/v0.1.3
- 固定版本 ZIP：https://github.com/WOOWTECH/hermes-paseo-plugin/archive/refs/tags/v0.1.3.zip
- Paseo 官方介面：https://app.paseo.sh

公開下載不需要 GitHub token。Web / CLI 從 GitHub 安裝會取得目前 main；ZIP 固定為 v0.1.3。

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

## 2. 安裝：Web 方式（建議）

1. 正常登入 Hermes Web，進入 **Plugins**。
2. 找到 **Install from GitHub / Git URL**。
3. 在 **Git URL or owner/repo** 輸入 `WOOWTECH/hermes-paseo-plugin`。
4. 新安裝時，開啟 **Enable after install**，按 **Install**。
5. 確認 `hermes-paseo` 卡片顯示 `enabled`；若未啟用，按 **Enable**。
6. Hermes 0.19 需重新整理頁面一次，才會載入剛安裝／啟用的插件。
7. 若 Paseo 頁顯示後端 API 尚未載入或 404，在 Paseo 頁按 **重載 Dashboard → 確認重載**。準備好的主機會等待後端重新啟動及插件 API 恢復，再自動重新整理目前頁面。
8. 如果重載按鈕無法使用，表示主機尚未安裝重載介面；管理者需先完成一次性 [主機設定](dashboard-control.zh-TW.md)。這個設定屬於主機部署，不會由普通插件 API 自行提升權限安裝。

已從 GitHub 安裝時，使用該插件卡片的 **Git pull** 更新；更新 Python 後端後同樣需重載舊版 Dashboard。已部署的主機可直接從第 5 節開始測試。

從較舊 Hermes 升級後，若 Git pull 顯示 `has no owned Git checkout; reinstall from its source`，先停止 Paseo 服務，再從同一官方 repo 重新安裝並勾選 **Force reinstall** 與 **Enable after install**。原生安裝器會建立新版需要的 checkout ownership 紀錄；`plugin-data/hermes-paseo/` 保留。不要自行偽造 ownership 檔案或放寬 Git 安全檢查。

Hermes 0.22 的 SDK 會自動附上 `profile=default`；0.1.4 支援這個啟動 profile 的別名，仍拒絕其他 profile 與額外 query。此版本請在 `default` profile 使用。

## 3. 安裝：CLI 或 ZIP 方式

CLI 與 Web 安裝擇一。在 Hermes 使用的服務帳戶與 profile 中執行：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin
hermes plugins enable hermes-paseo
```

若要使用固定版本 ZIP：

1. 下載上述 v0.1.3 ZIP 並解壓。
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
5. 在 Paseo 按 **New workspace**，選擇 Hermes 模型。第一次測試建議使用 **Default** 權限模式。

Hermes 頁面的模型／模式選單用於探索可用選項；實際對話設定在 Paseo 建立對話時選擇。官方 relay 不需要額外的 Paseo 密碼。配對連結可能授予存取權，請保留給自己的裝置使用。

若其他插件的引導視窗擋住操作，可使用該視窗的「稍後設定」，再進入 Paseo。

## 6. 測試功能

在 Paseo 送出：

```text
請記住 WOOW_TEST_001，只回覆這段文字，不要使用工具或修改檔案。
```

收到回覆後再送出：

```text
我剛才要你記住什麼？只回覆那段文字，不要使用工具。
```

兩輪都回覆 `WOOW_TEST_001`，才算完成首輪與記憶續聊測試。也可在 Hermes 插件頁按 **執行真實對話驗收（會消耗帳號額度）**，檢查結果；此按鈕使用後端代理的預設設定，不使用探索選單的選擇。

驗收會使用真實模型帳號額度。自動驗收完成後歸檔此次測試代理並保留歷史；手動建立的測試對話由使用者在 Paseo 歸檔。

要在 Hermes 對話使用原生工具，若 profile 限定工具集，將 `hermes_paseo` 納入需要使用的工具集；單次 CLI 測試可用：

```bash
hermes chat --toolsets hermes_paseo --query "請用 paseo_status 查看連線狀態"
```

## 7. 停止、恢復及移除

在 Paseo 插件頁按 **停止服務**，確認停止後重新整理；服務應保持停止。再按 **恢復服務**，確認回到就緒。這個操作保留配對設定與對話資料。

Hermes 0.19 沒有插件卸載 callback。要停用／移除時，先用插件頁或 `/paseo stop` 停止 daemon，確認 `/paseo status` 的 `daemon.running=false`，再到 Plugins 停用／移除。

Hermes 0.19 的首次引導為插件頁配對精靈；此版沒有公開的新建原生聊天 API，因此不宣稱啟用後會自動建立新的原生 Hermes 聊天。

## 常見問題

| 現象 | 處理方式 |
| --- | --- |
| 啟用後側欄沒有 Paseo | Hermes 0.19 重新整理頁面一次。 |
| 插件 API 404／尚未載入 | 在插件頁按「重載 Dashboard」並確認；主機需先配置重載介面。 |
| 403／Origin 被拒絕 | 確認插件已啟用及登入有效；使用服務帳戶設定精確正式 Origin。 |
| 沒有模型或無法回覆 | 確認 Hermes ACP 已安裝，並完成 Hermes 官方模型登入／設定。 |
| 沒有 Claude Code、Codex 或 Pi | 需先在同容器安裝與完成各官方登入，才會被插件偵測。 |
| Hermes 對話找不到插件工具 | 檢查 profile 的工具集白名單是否包含 `hermes_paseo`。 |

參考：[Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)、[Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)、[本插件說明](../README.md)。
