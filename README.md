# Jev-Trade-D2R

用瀏覽器 Agent 查詢《暗黑破壞神 2：獄火重生》(D2R) 在 [Traderie](https://www.traderie.com/diablo2resurrected) 上某件裝備的**目前掛單**與**近期成交**，並整理成兩張表格。

## 專案目的（本階段）

本階段只專心完成這一條流程：

> 搜尋 → 進商品頁 → 讀取所有掛單資料 → 切到近期成交 → 讀取所有成交資料

規則：

- 只有 **Jev（TypeSafe）** 負責決定瀏覽器要做什麼動作（點擊、輸入、捲動）。
- 本階段**不做**任何 LLM 資料分析（沒有價格統計、沒有行情判讀）。
- 表格是用**固定規則的文字解析**（`core/jev_ultrafast/traderie/parsing.py`）從網頁文字整理出來的，不是 AI 產生的。
- 顯示的是 Traderie 網頁上看得到的內容，不代表官方定價，也不保證涵蓋全部成交。

## 流程與分工

1. 從 `https://www.traderie.com/diablo2resurrected` 開始。
2. Agent 自己找到搜尋框，輸入裝備名稱，進入商品頁。
3. Agent 讀取 **Trading（目前掛單）**：捲到頁面底部、按「Load More」，最多 `LOAD_MORE_LIMIT` = 5 次，程式會自己數按了幾次，「捲到底」和「Load More」的輪流也由程式照規則執行，數到上限就直接結束這一段（不再問 Jev，決策紀錄會標示「規則」）。
4. Agent 自己點擊 **Recent Trades（近期成交）** 分頁。
5. Agent 用同樣方式讀取所有成交資料（最多按 5 次 Load More）。
6. 網頁 demo 顯示兩張表格（每筆資料一列）；「產生報告」按鈕只負責把結果存成檔案。

| 誰 | 做什麼 |
| --- | --- |
| Agent（Jev 決策） | 搜尋、進商品頁、捲動、按 Load More、切到近期成交，每一步都由它決定 |
| 程式（controller） | Agent 每完成一個視圖的那一刻，就讀取它**當下所在**的頁面並整理成表格；不會自己換頁、也不重試 |
| 「產生報告」按鈕 | 只把已讀到的結果存檔，不再讀網頁 |

## 快速開始

### 1. 環境需求

- Python 3.12 以上、[uv](https://docs.astral.sh/uv/)
- Google Chrome。預設由程式自己啟動一個無畫面的專用 Chrome（port 9355，資料放在 `.tmp-jev-chrome`），不會動到你自己的 Chrome。
  - 環境變數 `JEV_CHROME` 可切換：`headless`（預設，無畫面）、`window`（專用 Chrome 但看得到視窗）、`existing`（改用你自己的 Chrome，需開啟遠端除錯 port 9222；若 Chrome 詢問是否允許遠端除錯，需要你自己按「允許」）。
  - 專用 Chrome 為了省記憶體會擋掉廣告與追蹤程式；命令列和測試（不看截圖時）也不載入圖片，demo 畫面維持有圖。你自己的 Chrome 模式不受影響。
- `.env`（由 `.env.example` 複製）。主要欄位名稱：
  - `TYPESAFE_API_KEY`：Jev（TypeSafe）決策用，必填；`TYPESAFE_MODEL` 可選
  - `TYPESAFE_DEMO_PORT`（選填，預設 8766）
  - `JEV_INPUT_USD_PER_MILLION`、`JEV_OUTPUT_USD_PER_MILLION`（選填，預設 0.042 / 0，單位：美元／百萬 token，用來估算 demo 上顯示的費用；預設是 TypeSafe 公開價目，你的實際帳單可能不同）
  - `TRADERIE_COOKIE`、`TRADERIE_SESSION_TOKEN`、`TRADERIE_SESSION_COOKIE_NAME`（選填，登入用）

### 2. 安裝

```bash
uv sync
```

### 3. 啟動網頁 demo

```bash
uv run python core/jev_ultrafast/demo.py
```

開啟 http://127.0.0.1:8766，然後：

1. 在「裝備英文名稱」輸入（例如 `Harlequin Crest`）。
2. 按「開始查詢」。Agent 會自己走完整個流程，想中途停下可按「停止」。頁面上方有三個分頁：「查詢過程」（截圖與步驟）、「查詢結果」（兩張表格）、「用量與決策」（token、費用、Jev 每一步的決策）。
3. 兩個視圖都讀完時，畫面會自動切到「查詢結果」（寬度 1000 像素以上時掛單在左、成交在右並排，畫面上「高符文價值」顯示在「要價」下方；較窄時上下堆疊，欄位照舊）（如果你自己切到別的分頁，就不會被拉回，只在「查詢結果」旁出現紅點提示）。「用量與決策」分頁的每一行是 Jev 的一次決策，只顯示機率：選了什麼、操作機率與目標機率、兩個次高的選項；第一名與第二名只差 15 個百分點內會標「（接近）」。每個視圖會按「載入更多」（輸入框旁的下拉選單可選 0～5 次，預設 2 次；預設值在 `jev_ultrafast/traderie/site.py` 的 `LOAD_MORE_LIMIT`；命令列用 `--load-more N`）。實測：0 次約 50 筆掛單、20 筆成交、約 19 秒、約 $0.0008；2 次約 150／60 筆、約 31 秒、約 $0.0018；4 次約 250／100 筆、約 50 秒、約 $0.0028。選單旁會顯示預估，表格說明列會標示「網站上還有更多」或「已全部載入」。每張表格右上角有「匯出 CSV」（Excel 可直接開啟；以 = + - @ 開頭的內容前面會加一個 '，避免被當成公式）。
4. 兩個視圖都通過檢查後，按「產生報告」存檔，並可在頁面下載報告。

### 4. 命令列（同樣的流程）

```bash
uv run python examples/traderie.py "Harlequin Crest"
```

可加 `--output <資料夾>`（預設 `artifacts/traderie/latest`）與 `--keep-open`（結束後保留瀏覽器）。檢查未通過時指令以非零狀態結束。

## 輸出檔案

寫入 `artifacts/traderie/latest/`（不進版本庫）：

| 檔案 | 內容 |
| --- | --- |
| `verification.json` | 每次存檔都會寫；各項檢查結果、失敗項目與原因 |
| `market.json` | 兩個視圖的網址、標題、讀取時間與表格資料；僅在全部檢查通過時寫入 |
| `market_report.md` | 兩張表格的 Markdown 報告（目前掛單、近期成交）；僅在全部檢查通過時寫入 |

檢查未通過時，舊的 `market.json` 與 `market_report.md` 會被移除。命令列另外寫 `state.json`（步驟歷程與讀取結果）與 `session.json`（瀏覽器分頁識別）。

每個視圖的狀態：

- **PASSED**：讀到資料，且表格筆數與網頁上的筆數一致、商品名稱正確。
- **FAILED**：沒讀到、筆數不一致、Agent 停在錯的頁面或商品不符；原因會寫在 `verification.json`。
- **BLOCKED**：被網站擋下（Cloudflare／驗證碼／登入牆等）。
- **NOT_RUN**：尚未輪到讀取。

Agent 說「完成」不等於成功；是否成功只看上面的獨立檢查。

### 遇到登入牆

專用 Chrome 沒登入時，Traderie 不讓人按「Load More」，近期成交也可能要求登入。第一次請登入一次，之後專用 Chrome 會記得：

1. 執行 `uv run python scripts/login_traderie.py`，會開出一個看得到的 Chrome 視窗。
2. 在視窗裡登入 Traderie；若看到「Patch Notes」之類的公告視窗，請按右上角 × 關掉（專用 Chrome 會記得，網站出新公告時可能需要再關一次）；登入後回到終端機按 Enter。
3. 重新執行查詢。

若改用 `JEV_CHROME=existing`，則在你自己的 Chrome 登入 traderie.com 即可。

## 檔案地圖（本階段流程）

| 檔案 | 職責 |
| --- | --- |
| `core/jev_ultrafast/demo.py` | 網頁 demo 伺服器（`127.0.0.1:8766`），指令 `reset`／`tick`／`report`，`GET /api/report` 取得報告 |
| `core/jev_ultrafast/static/` | demo 介面（`index.html`、`app.js`、`style.css`、`csv.js`） |
| `core/jev_ultrafast/agent.py` | Agent 主迴圈：觀察 → 決策 → 執行 |
| `core/jev_ultrafast/browser.py` | 透過 Chrome DevTools Protocol 操作瀏覽器 |
| `core/jev_ultrafast/chrome.py` | 啟動與關閉專用 Chrome（`JEV_CHROME` 模式） |
| `core/jev_ultrafast/snapshot.js` | 在頁面內擷取可操作元素與捲動控制（含捲到底、捲到頂、等待） |
| `core/jev_ultrafast/model.py`、`questions.py` | 呼叫 Jev（TypeSafe）做決策 |
| `core/jev_ultrafast/config.py` | 設定與 `.env` 讀取 |
| `core/jev_ultrafast/traderie/site.py` | 網址、Agent 目標文字（`build_goal`）、`LOAD_MORE_LIMIT`、防護頁偵測 |
| `core/jev_ultrafast/traderie/controller.py` | 每個視圖讀一次、檢查、存檔（`read_view`、`verify_views`、`advance`、`run_agent`、`save_report`） |
| `core/jev_ultrafast/traderie/parsing.py` | 固定規則的掛單／成交文字解析 |
| `core/jev_ultrafast/traderie/verification.py` | 獨立檢查（`verify_market`、`read_settled_page`） |
| `core/jev_ultrafast/traderie/auth.py` | 憑證與 cookie 處理 |
| `extension/`、`services/` | Chrome 擴充功能與後端（見各自的 README） |
| `examples/traderie.py` | 命令列入口 |
| `scripts/login_traderie.py` | 開啟專用 Chrome 視窗，讓你登入 Traderie 一次 |

## 測試

```bash
uv run ruff check .
uv run pytest                          # 離線，預設不含 live
uv run pytest -m live                  # 真實網站、Chrome、TypeSafe（計費）
node --check core/jev_ultrafast/static/app.js
node --check core/jev_ultrafast/static/csv.js
uv build
```

Agent 每次執行結果並不固定（非決定性）。單次 live 測試失敗（例如搜尋到錯的結果、被網站擋下）不代表程式有 bug，請重跑再判斷。

## 安全與規範（摘自 AGENTS.md）

- 不寫網站專屬的步驟計畫，也不寫死輸入值或點擊目標；模型不產生選擇器或可執行程式碼。
- 永遠不重試瀏覽器的「改動」動作。
- 憑證只放在伺服器端與 `.env`，`.env` 不進版本庫；測試不得呼叫付費 API。
- Agent 選擇 `DONE` 不是成功的證據，結果必須獨立驗證。
- 只讀取，不聯絡賣家、不出價、不離開 Traderie D2R 商品／搜尋頁。
