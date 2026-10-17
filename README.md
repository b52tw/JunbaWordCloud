# 峻爸互動文字雲

掃描 QR Code 即可用手機投稿與讚同，主持台與投影畫面即時同步。作者：峻爸。

## 功能

- iPhone、Android 與電腦響應式介面；手機可各自使用 Wi-Fi 或行動網路。
- 文字以可愛雲朵彈出、輕搖，依投稿次數＋讚同數放大；可更換字體、配色及關閉動畫。
- 投稿統計、每則發言讚同、暫停收件、清空重來與 CSV 匯出。
- 最多 100 題的題庫，支援新增、切換、匯入與匯出。
- Windows 本機版與 Cloudflare 線上版共用前端。

## Cloudflare 線上部署

GitHub 保存程式碼；完整的即時同步服務由 Cloudflare Workers、SQLite Durable Objects 與 Static Assets 執行。GitHub Pages 本身無法執行這個後端。

在 Cloudflare Workers & Pages 匯入本專案，設定：

| 項目 | 值 |
| --- | --- |
| 根目錄 | `online` |
| 建置指令 | `npm ci` |
| 部署指令 | `npx wrangler deploy` |
| 正式分支 | `main` |

部署後在 Worker 的 Settings → Variables and Secrets 新增 **Secret** `SETUP_KEY`，值請自行設定至少 24 個字元。這是建立活動用的管理碼，請勿使用 Google、GitHub 或其他帳號密碼，也不要提交到程式碼。

開啟 Worker 網址，輸入活動管理碼即可建立活動。請私下保存主持連結；僅將參加者連結或 QR Code 提供給大家。

也可使用 CLI：

```sh
cd online
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put SETUP_KEY
```

## 本機開發與驗證

```sh
cd online
npm ci
npm run check
npm run dry-run
npm run dev
```

本機測試須另設開發環境的 `SETUP_KEY`，請將它放在未追蹤的 `.dev.vars`，不要提交。

`runtime_check.mjs` 提供 Miniflare 的 200 個模擬連線驗證。模擬結果不等於實際學校網路與手機的壓力測試；正式活動前請以實際設備演練。

## Windows 本機版

安裝 Go 後執行 `build_windows.bat` 可編譯。Windows 10／11 為目標系統，XP 不在支援範圍。手機與主機需連上可互通的區域網路，並允許程式接收連線；無法保證通過學校的網路或防火牆政策。

## 資料與授權

線上活動資料存於您的 Cloudflare 帳號。參加者不需登入，讚同以瀏覽器匿名識別防重複，不等同實名一人一票。請避免投稿敏感個資。

字型及 QR Code 程式的第三方授權保留於 `web/fonts/` 與 `vendor/`。
