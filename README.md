# Hermes Paseo plugin

Hermes Agent / Web 插件：啟用後準備固定 Paseo runtime，在受保護的插件頁完成官方加密 relay 配對，於 Paseo 選取 Hermes ACP 模型並建立及接續對話。

公開 repo：<https://github.com/WOOWTECH/hermes-paseo-plugin>。下載不需要 GitHub 帳號或 token。

完整中文教學：[下載、安裝、部署與測試](docs/install.zh-TW.md)。

目前為公開預覽版本。部署到正式環境前，請在自己的主機完成 Web 安裝／啟用、官方配對及首輪／續聊驗收；各版本的支援範圍與驗收方式見 [實測紀錄](docs/validation.md)。

2026-10-26 最新重測：PaaS `.263` 已透過服務專用版本固定及原生 Redeploy，將測試站升至 chart `0.4.0`。Dashboard adapter、原 Hermes 映像、CPU 限制與 10 GiB 磁碟均保留；原配對、部署前對話的記憶續聊、官方 Paseo 新對話與 Dashboard 重載期間的背景驗收通過。平台部署模板整合已完成此環境的實測。

同日追加 [官方 Paseo Web 詳細測試](docs/web-acceptance-20261026.zh-TW.md)：新裝置配對、手機模擬續聊、即時模型／模式切換、中止、雙裝置並行、明確斷線後重連與歷史歸檔通過。附件上傳成功，但測試 profile 缺少檔案工具，模型讀取附件未通過；還原後續聊遇到訂閱 HTTP 429。這兩項仍須完成配置／額度條件及重測，不能宣稱所有功能正常。

測試站使用自己已授權的 Hermes `openai-codex:gpt-6.1-sol`，另已通過三路並行共六段對話、插件資料還原及可控跨節點搬移。早期 0.8B 本機模型的失敗紀錄保留於驗收文件。此版本可公開下載試用；長期負載、整機災難復原及其他環境仍待驗收。

## 安裝與配對

在 Hermes Web 的插件頁選擇從 GitHub 安裝，輸入 `WOOWTECH/hermes-paseo-plugin`。CLI：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin
hermes plugins enable hermes-paseo
```

原生 Agent 插件與 Dashboard 頁面均包含在同一 repo。啟用後開啟 Paseo 頁面，按引導準備服務與產生配對；在新分頁開啟官方 Paseo，按 Connect 完成綁定，再選 Hermes、模型與權限模式。

配置 0.1.4 主機介面時，仍啟用的服務在容器啟動後會準備 runtime，並在 daemon 意外中斷後恢復，不需開啟瀏覽器。手動停止的狀態會保留；Hermes Web 停用／移除插件前也會先確認服務停止。未配置主機介面時，仍使用可見 Web 頁面的恢復流程，CLI 移除前須先停止服務。

文字對話服務預設不下載額外語音模型，保留使用者既有的明確語音啟用設定。主機介面另依容器 CPU quota 設定本機推理的預設執行緒數，保留管理者明確的環境設定。

首次安裝的後端 API 是否能立即使用，依 Hermes 版本而異。Paseo 頁提供「重載 Dashboard → 確認重載」；配置好主機介面後，即使插件 API 尚未載入也可使用，完成後自動回到目前頁面。管理者須先完成一次性 [Dashboard 主機設定](docs/dashboard-control.zh-TW.md)；未配置主機會停用此按鈕並說明原因。

Hermes 0.19 的 Web 插件列表只在頁面載入時讀取。從插件頁安裝或啟用後，請重新整理一次；插件載入後會自動開啟尚未完成的配對指南。

官方 relay 不需要額外 Paseo 密碼。缺少模型登入時，使用 Hermes 的官方模型／登入設定；不要將密碼、OAuth token 或配對連結貼到聊天中。插件不讀取或複製模型憑證。

## 在 Hermes 對話調用插件

插件提供 `paseo_status`、`paseo_start`、`paseo_stop`、`paseo_models`、`paseo_chat`、`paseo_continue`。若 profile 已限定工具集，請在 Hermes 工具設定將 `hermes_paseo` 納入需要使用的工具集；插件保留原有白名單，不會改成全部開放。

單次 CLI 對話可明確選用：

```bash
hermes chat --toolsets hermes_paseo --query "請用 paseo_status 查看連線狀態"
```

也可用 `/paseo` 查看引導，`/paseo status`、`/paseo start`、`/paseo stop` 直接控制。配對邀請由受保護的 Dashboard 頁面取得。

## 環境與資料

Linux、Python 3.11+、Node.js 22.19.0+、npm、util-linux flock；Hermes 須支援原生 Dashboard plugins 與 `hermes acp`，並已安裝 ACP extra。插件不自動替換 Hermes 核心或 Python 環境。

每個 Hermes profile 的 plugin-data/hermes-paseo 存放 runtime、Paseo home、狀態與初始化紀錄；不與 Pi plugin 或使用者原來的 Paseo home 混用。停止後保留手動暫停、登入與對話資料。Hermes 0.19 沒有公開卸載 callback，停用／移除插件前請先在 Paseo 頁按「停止服務」，或執行 `/paseo stop`，確認 `/paseo status` 中 `daemon.running=false` 後再停用；此版本不宣稱停用按鈕會自動清理背景 daemon。其他同容器已安裝的 Claude Code、Codex、Pi 會被偵測；缺少或未登入的 provider 不宣稱能對話。

狀態與診斷不等同真正模型回覆；對話驗收會使用帳號額度，完成後歸檔此次測試 agent、保留紀錄。配對 URL 只在受保護設定頁傳遞，API 使用 no-store/no-referrer。

入口代理若清空 Origin 或改寫 Host，必須先驗證允許的正式 Origin，並保留／拒絕瀏覽器 cross-site Fetch Metadata；不可只依靠重寫後的後端 Origin 判斷。

若 HTTPS 入口經 HTTP 代理後遺失原本協定或 Host，由管理者使用 Hermes 服務帳戶為該 profile 設定正式 Origin：

```bash
python3 ~/.hermes/plugins/hermes-paseo/bin/configure-origin.py https://hermes.example.com
```

自訂 `HERMES_HOME` 時請改用該 profile 下的插件路徑，並沿用相同環境。設定寫入私有 `plugin-data/hermes-paseo/dashboard-origin.json`，要求本帳戶擁有、無其他帳戶讀寫權限；禁止 credentials、path、query、fragment。插件只接受這個精確 Origin，仍拒絕 cross-site Fetch Metadata，不信任客戶端任意 Forwarded 標頭。這個設定不包含密碼，也不更改 Hermes 登入。

## 開發驗證

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py'
npm audit --omit=dev --prefix runtime
```

[維運與可重複驗收](docs/operations.zh-TW.md) 包含有上限的真實並行測試工具，以及已實測的插件備份還原範圍。部署及實測結果會記錄於 docs/validation.md。各平台的登入與額度會變化，必須以新的首輪及續聊驗證為準。

## 官方介面

- [Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)
- [Paseo Hermes ACP](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)

MIT；Paseo runtime 隔離、程序擁有權及狀態鎖實作沿用 WOOWTECH Pi Paseo plugin 0.1.3，見 NOTICE.md。
