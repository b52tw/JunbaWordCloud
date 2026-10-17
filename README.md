# 峻爸互動文字雲

掃描 QR Code 即可用手機投稿與讚同，主持台與投影畫面即時同步。作者：峻爸。

## 功能

- iPhone、Android 與電腦響應式介面；手機可各自使用 Wi-Fi 或行動網路。
- 文字以可愛雲朵彈出、輕搖，依投稿次數＋讚同數放大；可更換字體、配色及關閉動畫。
- 投稿統計、每則發言讚同、暫停收件、清空重來與 CSV 匯出。
- 最多 100 題的題庫，支援新增、切換、匯入與匯出。
- Windows 本機版與 Cloudflare 線上版共用前端。

## 在您自己的瀏覽器發布

請在您已登入 Cloudflare 的 Chrome／Edge／Safari 操作，不必登入 ChatGPT 的雲端瀏覽器。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/b52tw/JunbaWordCloud)

1. 點上方 **Deploy to Cloudflare**。這是 Cloudflare 官方部署入口，會把本專案複製到您選擇的 GitHub 帳號並架設服務。
2. 依畫面連接 GitHub。新專案副本可命名 `JunbaWordCloud-Online`，避免與現有的 `JunbaWordCloud` 同名。
3. 如出現 `SETUP_KEY`，請自行設定至少 **24 個字元**的活動管理碼，混用英文字母與數字並私下保存。請勿使用 Google／GitHub 密碼，也不要把管理碼貼到聊天、GitHub 或截圖中。
4. 按部署，等待成功後開啟畫面提供的 **workers.dev** 網址。
5. 開啟網站，輸入剛才的活動管理碼建立活動。請私下保存主持連結，將參加者 QR Code 或參加者連結提供給大家。

請選 **Workers Free** 免費方案；這個專案不需要購買網域。若畫面要求信用卡或付費升級，先停止並確認是否選到其他服務。

### 若部署頁沒有詢問活動管理碼

部署後到該 Worker 的 **Settings（設定）→ Variables and Secrets（變數與秘密）→ Add（新增）**：

| 項目 | 填入 |
| --- | --- |
| Type | **Secret** |
| Name | `SETUP_KEY` |
| Value | 您自行設定的至少 24 個字元管理碼 |

儲存並部署後重新開啟網站。這個管理碼只供主持人建立活動，參加者不需知道。

### 管理碼無法使用時

首頁會先檢查網站設定，只顯示設定狀態，不會回傳管理碼或實際字數：

- **未讀到活動管理碼**：請確認在 Worker 正式（生產）環境設定秘密 `SETUP_KEY`，並儲存部署。
- **Cloudflare 儲存的管理碼不足 24 個字元**：請編輯該秘密的值，設定至少 24 個英數字元，再儲存部署。
- **活動管理碼不正確**：雲端設定已符合長度，但網站輸入與雲端儲存值不同；請檢查大小寫、空格及輸入是否完整。

儲存部署後重新整理文字雲首頁。管理碼請自行保管，不要傳給他人、提交到程式碼或拍進截圖。

### 使用原本的 GitHub 專案，不建立副本

也可在您自己的 Cloudflare 控制台，從 **Workers & Pages → Create application（建立應用程式）→ Import a repository（匯入儲存庫）**，連接 GitHub 並選 `b52tw/JunbaWordCloud`。

若 GitHub 詢問儲存庫存取範圍，優先使用 **Only select repositories**，選擇本次要部署的專案。

| 項目 | 值 |
| --- | --- |
| Worker 名稱 | `junba-wordcloud` |
| 根目錄 | 專案根目錄，留白或 `/`；不必填 `online` |
| 建置指令 | 留白；平台會安裝 npm 套件 |
| 部署指令 | `npx wrangler deploy` |
| 正式分支 | `main` |

部署成功後依上節設定 **Secret** `SETUP_KEY`。**建置環境的秘密**與 **Worker 執行時的秘密**不同；手動匯入時請設定在部署後 Worker 的 Settings → Variables and Secrets。

### 服務架構

GitHub 保存程式碼；完整的即時同步服務由 Cloudflare Workers、SQLite Durable Objects 與 Static Assets 執行。GitHub Pages 本身無法執行這個後端。

程式碼上傳到 GitHub 後仍需完成 Cloudflare 部署；部署成功以 Cloudflare 顯示的結果為準。請先用少量手機測試投稿、讚同、換題與清空，再進行多人演練。

## 本機開發與驗證

現在可以直接在專案根目錄執行，不必切換子目錄：

```sh
npm ci
npm run check
npm run dry-run
npm run dev
```

本機測試請複製 `.dev.vars.example` 為未追蹤的 `.dev.vars`，自行填入開發用管理碼，不要提交。

CLI 部署方式：

```sh
npx wrangler login
npm run deploy
npx wrangler secret put SETUP_KEY
```

`online/` 原有的獨立指令與設定仍可使用，但根目錄的設定是 GitHub／Cloudflare 匯入的預設入口。

`online/runtime_check.mjs` 提供 Miniflare 的 200 個模擬連線驗證。模擬結果不等於實際學校網路與手機的壓力測試；正式活動前請以實際設備演練。

## Windows 本機版

安裝 Go 後執行 `build_windows.bat` 可編譯。Windows 10／11 為目標系統，XP 不在支援範圍。手機與主機需連上可互通的區域網路，並允許程式接收連線；無法保證通過學校的網路或防火牆政策。

## 資料與授權

線上活動資料存於您的 Cloudflare 帳號。參加者不需登入，讚同以瀏覽器匿名識別防重複，不等同實名一人一票。請避免投稿敏感個資。

字型及 QR Code 程式的第三方授權保留於 `web/fonts/` 與 `vendor/`。
