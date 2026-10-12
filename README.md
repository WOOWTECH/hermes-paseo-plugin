# Hermes Paseo plugin

Hermes Agent / Web 插件：啟用後準備固定 Paseo runtime，在受保護的插件頁完成官方加密 relay 配對，於 Paseo 選取 Hermes ACP 模型並建立及接續對話。

公開 repo：<https://github.com/WOOWTECH/hermes-paseo-plugin>。下載不需要 GitHub 帳號或 token。

## 安裝與配對

在 Hermes Web 的插件頁選擇從 GitHub 安裝，輸入 `WOOWTECH/hermes-paseo-plugin`。CLI：

```bash
hermes plugins install WOOWTECH/hermes-paseo-plugin
hermes plugins enable hermes-paseo
```

原生 Agent 插件與 Dashboard 頁面均包含在同一 repo。啟用後開啟 Paseo 頁面，按引導準備服務與產生配對；在新分頁開啟官方 Paseo，按 Connect 完成綁定，再選 Hermes、模型與權限模式。

首次安裝的後端 API 是否能立即使用，依 Hermes 版本而異。沒有插件後端熱載入的版本需要重新啟動 Hermes Dashboard 一次；頁面會顯示重啟提示，不會把尚未載入當成已配對。這不需要升級 Hermes 映像。

官方 relay 不需要額外 Paseo 密碼。缺少模型登入時，使用 Hermes 的官方模型／登入設定；不要將密碼、OAuth token 或配對連結貼到聊天中。插件不讀取或複製模型憑證。

## 環境與資料

Linux、Python 3.11+、Node.js 22.19.0+、npm、util-linux flock；Hermes 須支援原生 Dashboard plugins 與 `hermes acp`，並已安裝 ACP extra。插件不自動替換 Hermes 核心或 Python 環境。

每個 Hermes profile 的 plugin-data/hermes-paseo 存放 runtime、Paseo home、狀態與初始化紀錄；不與 Pi plugin 或使用者原來的 Paseo home 混用。停止後保留手動暫停、登入與對話資料。其他同容器已安裝的 Claude Code、Codex、Pi 會被偵測；缺少或未登入的 provider 不宣稱能對話。

狀態與診斷不等同真正模型回覆；對話驗收會使用帳號額度，完成後歸檔此次測試 agent、保留紀錄。配對 URL 只在受保護設定頁傳遞，API 使用 no-store/no-referrer。

入口代理若清空 Origin 或改寫 Host，必須先驗證允許的正式 Origin，並保留／拒絕瀏覽器 cross-site Fetch Metadata；不可只依靠重寫後的後端 Origin 判斷。

## 開發驗證

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py'
npm audit --omit=dev --prefix runtime
```

部署及實測結果會記錄於 docs/validation.md。各平台的登入與額度會變化，必須以新的首輪及續聊驗證為準。

## 官方介面

- [Hermes 原生插件](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes Dashboard 擴充](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)
- [Paseo Hermes ACP](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)

MIT；Paseo runtime 隔離、程序擁有權及狀態鎖實作沿用 WOOWTECH Pi Paseo plugin 0.1.3，見 NOTICE.md。
