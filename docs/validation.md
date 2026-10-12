# Hermes Paseo 驗收紀錄

2026-10-12；首個使用者授權實測目標為 woowtech Hermes，Hermes 0.19.0 / Python 3.13.5 / Node 22.22.3。未升級 Hermes 映像或更改既有模型登入。

已使用 Hermes 的服務帳戶在 profile 專用目錄準備並啟動固定 Paseo 0.11.2 runtime。官方 ACP catalog 實測取得 13 個模型，以及 Default、Accept Edits、Don't Ask 三個模式；預設 `custom:chatgpt/gpt-5.6-sol`。

透過真實 Paseo daemon 建立 Hermes agent：首輪 assistant 正確回覆測試 marker；第二輪記住前文並回覆相同 marker。驗收通過並歸檔此次測試 agent，保留對話紀錄。CLI 存在或模型清單不被當作對話成功證據。

同容器尚未安裝 Claude Code、Codex、Pi，因此本次不宣稱三者已可對話。插件會偵測已安裝的 companions，登入需使用各官方流程。

固定 runtime 的執行依賴稽核為 0 項已知弱點。本機 Node/runtime/UI 測試 40/40，Python bridge/API 測試 38/38，均通過；跨程序狀態鎖、程序群組 timeout 清理、profile 隔離、背景啟動／停止競態、配對資訊遮罩、同源／body 檢查、UI 自動引導與暫停保存均有行為驗證。

已從公開 repo 使用目標 Hermes 的官方 CLI 完成安裝與啟用，位置為 `/opt/data/plugins/hermes-paseo`，實作 source commit `f4398dc6bb471dd80c30dbe36cf19a0cbe73fed2`。原設定保存在同 profile 的私人備份，僅重載 Dashboard；重載後 health 200、ok=true、版本仍為 0.19.0。未登入的插件 API 返回 401，登入保護保留。

- [最新實作 CI](https://github.com/WOOWTECH/hermes-paseo-plugin/actions/runs/38199272081) 通過；公開 main 可匿名下載 ZIP（HTTP 200）。
- 安裝後重新完成 Hermes 首輪、記憶續聊及測試歸檔，全部通過。
- 實際 React／Chromium 的本機 DOM 驗證通過：啟用導向、第一次 start、手機 390 px、不在儲存體保存配對邀請、停止／恢復、卸載 UI 後停止輪詢。這部分的 API 為模擬資料。
- 另以正式插件的私人邀請完成官方 Paseo Connect，透過 relay 讀取本容器工作區，成功選取現有 Hermes 模型。
- 官方 Paseo UI 實際顯示 Default、Accept edits、Don't ask 三個模式；使用 Default 送出首輪與續聊，得到正確的記憶回覆，兩次測試均通過並已歸檔此次建立的 agent、保留紀錄。

仍待驗收：Hermes Web 插件頁本身的登入、GUI 安裝／啟用、頁面自動導向與從該頁產生配對。官方 CLI 安裝、Paseo UI 實測與模擬 DOM 不代替這一段；目前等待使用者提供此站台的正常登入方式。沒有讀取或搬移 Pod 裡的明文 Web 密碼。

Hermes 0.19 沒有公開插件建立全新 native 對話的介面：初始化使用耐久的插件流程紀錄，並可掛接後續真實 session，沒有虛構 Hermes 對話 ID。其首次安裝的 Dashboard API 需要重載一次。後續啟用由頁面引導進入配對流程。

支援範圍為 Linux 單一 Hermes profile。尚未建立長期 soak、大量並行模型對話或 SLA／容量承諾。

Hermes 0.19 停用／移除沒有公開卸載 callback：必須先用插件頁或 `/paseo stop` 停止 daemon，再停用／移除。不能把 host 關閉工具入口當作背景服務已停止。
