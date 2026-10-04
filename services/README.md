# 後端（Vercel 小後端）

這個後端只做三件事：檢查邀請碼、計算每日次數、替擴充功能問 Jev。**Jev 金鑰只放在這裡**，擴充功能裡沒有。

```
擴充功能 ──HTTPS──▶ Vercel（Python 函式） ──▶ Upstash Redis（邀請碼、次數）
                                           └─▶ TypeSafe（Jev）
```

| 端點 | 作用 |
|---|---|
| `POST /api/run/start` | 檢查邀請碼，今日次數加一（上限預設 100），回傳 30 分鐘有效的查詢憑證 |
| `POST /api/choose` | 帶查詢憑證與頁面內容，回傳 Jev 的選擇；每次查詢最多 30 次 Jev 呼叫 |

每日次數按台灣時間午夜 0 點重置。「一次」是一次完整查詢，不是一次點擊。

## 部署（用 Vercel CLI）

目前已部署在 `https://jev-trade-d2r.vercel.app`。以下是從頭做一次的步驟：

1. 登入：`npx vercel@latest login`
2. 打包：`uv run python services/build.py`
3. 建立並連結專案：`cd services/.build && npx vercel@latest link --yes --project jev-trade-d2r`
4. 建立 Redis（Upstash，第一次要在瀏覽器接受條款）：
   `npx vercel@latest integration add upstash/upstash-kv --name jev-invites --no-env-pull`
   它會自動把 `KV_REST_API_URL`、`KV_REST_API_TOKEN` 等變數設到專案。
5. 設定其他環境變數（值從 `.env` 或隨機產生，用 `--sensitive`，用標準輸入貼值）：
   `TYPESAFE_API_KEY`、`TYPESAFE_MODEL`、`RUN_TOKEN_SECRET`（至少 32 個隨機字元）：
   `npx vercel@latest env add <名稱> production --sensitive --yes`
6. 部署：`npx vercel@latest deploy --prod --yes`
7. 本機要管理邀請碼，需要把 `KV_REST_API_URL`、`KV_REST_API_TOKEN` 放進 `.env`：
   `npx vercel@latest env pull .env.pulled --environment production --yes`，再把這兩行複製進 `.env`，最後刪掉 `.env.pulled`。

之後改程式，只要重新執行第 2 步和第 6 步。入口是 `services/app.py`（一個 WSGI 應用）。

## 管理邀請碼

在專案根目錄執行（需要 `.env` 裡有 KV_REST_API_URL 與 KV_REST_API_TOKEN）：

```
uv run python services/invite.py add 小明              # 產生邀請碼，只顯示一次
uv run python services/invite.py add 小華 --limit 50 --expires 2026-12-31
uv run python services/invite.py list                  # 看誰用了幾次
uv run python services/invite.py revoke 小明           # 立刻停用，不影響別人
```

邀請碼只存雜湊值，忘了就只能再發一組。

## 本機試跑（不需要 Vercel 和 Upstash）

```
uv run python services/dev_server.py
```

會在 `http://127.0.0.1:8788` 啟動，資料放在記憶體，重開就清空；終端機會印出一組開發用邀請碼。這需要 `.env` 裡有 `TYPESAFE_API_KEY`。

## 費用與限制

- Jev：每次查詢約 $0.001–0.002。
- Vercel Hobby 方案是免費，但限個人、非商業使用。
- Upstash 免費方案每月 50 萬次指令；一次查詢約用 20 次，十個人每天都用滿 100 次會超過，超過時改成隨用隨付即可，不用改程式。
- 後端不記錄請求內容，只記邀請碼代號、時間和 token 數。頁面文字會經過這個後端送給 TypeSafe，請告訴使用者。
