# Jev-Trade-D2R

用瀏覽器 Agent 查詢《暗黑破壞神 2：獄火重生》(D2R) 在 [Traderie](https://www.traderie.com/diablo2resurrected) 上某件裝備的**目前掛單**與**近期成交**，並整理成兩張表格。

## 專案目的（本階段）

本階段只專心完成這一條流程：

> 搜尋 → 進商品頁 → 讀取所有掛單資料 → 切到近期成交 → 讀取所有成交資料

規則：

- 只有 **Jev（TypeSafe）** 負責決定瀏覽器要做什麼動作（點擊、輸入、捲動）。
- 本階段**不做**任何 LLM 資料分析（沒有價格統計、沒有行情判讀）。
- 表格是用**固定規則的文字解析**（`src/jev_ultrafast/traderie/parsing.py`）從網頁文字整理出來的，不是 AI 產生的。
- 顯示的是 Traderie 網頁上看得到的內容，不代表官方定價，也不保證涵蓋全部成交。

## 流程與分工

1. 從 `https://www.traderie.com/diablo2resurrected` 開始。
2. Agent 自己找到搜尋框，輸入裝備名稱，進入商品頁。
3. Agent 讀取 **Trading（目前掛單）**：捲到頁面底部、按「Load More」，預設最多 `LOAD_MORE_LIMIT` = 2 次（可選 0～5 次），程式會自己數按了幾次，「捲到底」和「Load More」的輪流也由程式照規則執行，數到上限就直接結束這一段（不再問 Jev，決策紀錄會標示「規則」）。
4. Agent 自己點擊 **Recent Trades（近期成交）** 分頁。
5. Agent 用同樣方式讀取所有成交資料（Load More 的次數上限同上）。
6. 網頁 demo 顯示兩張表格（每筆資料一列）；「產生報告」按鈕只負責把結果存成檔案。

| 誰 | 做什麼 |
| --- | --- |
| Agent（Jev 決策） | 搜尋、進商品頁、捲動、按 Load More、切到近期成交，每一步都由它決定 |
| 程式（controller） | Agent 每完成一個視圖的那一刻，就讀取它**當下所在**的頁面並整理成表格；不會自己換頁、也不重試 |
| 「產生報告」按鈕 | 只把已讀到的結果存檔，不再讀網頁 |

## 快速開始

### 1. 環境需求

- Python 3.12 以上、[uv](https://docs.astral.sh/uv/)
- Google Chrome。預設由程式自己啟動一個無畫面的專用 Chrome（port 9355，資料放在專案裡的 `src/.tmp-jev-chrome`），不會動到你自己的 Chrome。
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
uv run python demo.py
```

（`demo.py` 會先檢查專用 Chrome 有沒有登入 Traderie，沒登入就自動開一個視窗讓你登入一次；只啟動伺服器、不檢查登入的話用 `uv run python src/jev_ultrafast/demo.py`。）

開啟 http://127.0.0.1:8766，然後：

1. 在「裝備英文名稱」輸入（例如 `Harlequin Crest`）。
2. 按「開始查詢」。Agent 會自己走完整個流程，想中途停下可按「停止」。頁面上方有三個分頁：「查詢過程」（截圖與步驟）、「查詢結果」（兩張表格）、「用量與決策」（token、費用、Jev 每一步的決策）。
3. 兩個視圖都讀完時，畫面會自動切到「查詢結果」（寬度 1000 像素以上時掛單在左、成交在右並排，畫面上「高符文價值」顯示在「要價」下方；較窄時上下堆疊，欄位照舊）（如果你自己切到別的分頁，就不會被拉回，只在「查詢結果」旁出現紅點提示）。「用量與決策」分頁的每一行是 Jev 的一次決策，只顯示機率：選了什麼、操作機率與目標機率、兩個次高的選項；第一名與第二名只差 15 個百分點內會標「（接近）」。每個視圖會按「載入更多」（輸入框旁的下拉選單可選 0～5 次，預設 2 次；預設值在 `jev_ultrafast/traderie/site.py` 的 `LOAD_MORE_LIMIT`；命令列用 `--load-more N`）。實測：0 次約 50 筆掛單、20 筆成交、約 19 秒、約 $0.0008；2 次約 150／60 筆、約 31 秒、約 $0.0018；4 次約 250／100 筆、約 50 秒、約 $0.0028。選單旁會顯示預估，表格說明列會標示「網站上還有更多」或「已全部載入」。每張表格右上角有「匯出 CSV」（Excel 可直接開啟；以 = + - @ 開頭的內容前面會加一個 '，避免被當成公式）。
   - 上面的筆數、秒數與費用是**估算**，記錄日期 2026-10-04、模型 `jev-latest`、輸入價 0.042 美元／百萬 token；模型或價目改變後數字會不同，實際用量請看「用量與決策」分頁。
4. 兩個視圖都通過檢查後，按「產生報告」存檔，並可在頁面下載報告。

### 4. 命令列（同樣的流程）

```bash
uv run python scripts/traderie.py "Harlequin Crest"
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

1. 執行 `uv run python scripts/login.py`，會開出一個看得到的 Chrome 視窗。
2. 在視窗裡登入 Traderie；若看到「Patch Notes」之類的公告視窗，請按右上角 × 關掉（專用 Chrome 會記得，網站出新公告時可能需要再關一次）。視窗會一直開著，直到偵測到你已登入才自動關閉；登入後也可以直接回終端機按 Enter 提前結束等待（不按也會自己偵測到）。真的等太久（預設 600 秒，可用 `JEV_LOGIN_WAIT_SECONDS` 調整）會顯示訊息並以錯誤結束，重新執行即可。
3. 重新執行查詢。

若改用 `JEV_CHROME=existing`，則在你自己的 Chrome 登入 traderie.com 即可。

## 檔案地圖（本階段流程）

| 檔案 | 職責 |
| --- | --- |
| `src/jev_ultrafast/demo.py` | 網頁 demo 伺服器（`127.0.0.1:8766`），指令 `reset`／`tick`／`report`，`GET /api/report` 取得報告 |
| `src/jev_ultrafast/static/` | demo 介面（`index.html`、`app.js`、`style.css`、`csv.js`） |
| `src/jev_ultrafast/agent.py` | Agent 主迴圈：觀察 → 決策 → 執行 |
| `src/jev_ultrafast/browser.py` | 透過 Chrome DevTools Protocol 操作瀏覽器 |
| `src/jev_ultrafast/chrome.py` | 啟動與關閉專用 Chrome（`JEV_CHROME` 模式） |
| `src/jev_ultrafast/snapshot.js` | 在頁面內擷取可操作元素與捲動控制（含捲到底、捲到頂、等待） |
| `src/jev_ultrafast/model.py`、`questions.py` | 呼叫 Jev（TypeSafe）做決策 |
| `src/jev_ultrafast/config.py` | 設定與 `.env` 讀取 |
| `src/jev_ultrafast/traderie/site.py` | 網址、Agent 目標文字（`build_goal`）、`LOAD_MORE_LIMIT`、防護頁偵測 |
| `src/jev_ultrafast/traderie/controller.py` | 每個視圖讀一次、檢查、存檔（`read_view`、`verify_views`、`advance`、`run_agent`、`save_report`） |
| `src/jev_ultrafast/traderie/parsing.py` | 固定規則的掛單／成交文字解析 |
| `src/jev_ultrafast/traderie/verification.py` | 字詞比對與頁面讀取工具（`words`、`title_has_words`、`matches_item`、`page_matches_item`、`read_settled_page`）；各項獨立檢查在 `controller.verify_views` |
| `src/jev_ultrafast/traderie/auth.py` | 憑證與 cookie 處理 |
| `extension/`、`services/` | Chrome 擴充功能與後端（見各自的 README） |
| `scripts/traderie.py` | 命令列入口 |
| `scripts/login.py` | 開啟專用 Chrome 視窗，讓你登入 Traderie 一次 |

## Chrome 擴充功能

`extension/` 是給朋友用的 Chrome 側邊欄擴充功能：輸入裝備名稱（英文或繁體中文），按「開始查詢」，同樣讀取目前掛單與近期成交，顯示兩張表格並可匯出 CSV。查詢需要一組邀請碼，由後端（`services/`）代為呼叫 Jev，擴充功能裡沒有任何金鑰。

- 打包：`uv run python extension/build.py`（產生 `extension/dist` 與 zip）；安裝與操作見 `docs/Jev-Traderie-安裝操作.md`，開發說明見 `extension/README.md`。
- 找裝備分三層，各試一次：先查名稱對照表直接開商品頁（不呼叫 Jev）、再用站內搜尋（Jev 輸入並選結果）、搜尋找不到時才從固定的底材清單挑（程式先自己去掉品質字，例如 Rare Ring → Ring，找不到才問 Jev）。結果頁會註明是哪一層找到的。
- 「載入更多」的次數：擴充功能的預設目前是 **0**（`extension/src/sidepanel.js`），和網頁 demo 的預設 2 次不同；側邊欄可用 +／− 調成 0～5。這個預設沒有改動，是否要統一還沒決定。
- 每次查詢最多 30 次 Jev 呼叫（`extension/src/agent.js` 的 `JEV_CALL_LIMIT`，後端 `services/jevsvc/app.py` 同樣是 30）；網頁 demo 的上限不同（60 個動作、120 個決策），見 `docs/design.md` 的 Budgets 表。
- **模糊搜尋（適用黃・藍・白裝，第二種查法）**：名稱是隨機的裝備，Traderie 沒有對應的商品頁，用名稱找不到。打開側邊欄就是裝備掃描；模糊搜尋表單從掃描紀錄、或直接貼上裝備截圖進入（掃描紀錄的「模糊搜尋」會直接用底材和品質開始查，查完按「加詞綴條件縮小範圍」才會帶入詞綴），貼上裝備截圖或手動輸入底材，程式會填入底材（已支援繁體中文輸入自動轉換，例如輸入「戒指」、「權冠」會自動轉成對應英文底材「Ring」、「Circlet」，不可空；欄位會列出資料表裡的底材名稱讓你挑，你也可以自己打字）和一排詞綴條件（截圖讀出、辨識到的會自動勾上，**讀到的數字也會一起填進去並標成「從擷取讀到，請確認」**，也可以自己從選單新增）；你確認或修改數字、選品質（黃／藍／白）後按「開始查詢」。程式用 Traderie 首頁「Search All Stats」的篩選網址查，**不呼叫 Jev、不扣邀請碼次數**，只讀第一頁（最多 50 筆），並檢查網站真的保留了你的條件。結果上方會先給一句**價格結論**（讀到的掛單以「高符文價值」算出的最低／中位數／四分位，沒標價的會算筆數不猜數字），並註明這次查詢的輸入是打字、截圖還是掃描來的。屬性清單，以及首頁側邊欄的「物品類型」清單（決定底材能不能當網站篩選條件），都由 Traderie 提供、擴充功能讀取後存在這個瀏覽器 7 天；兩份都還在效期內時，查詢會直接開篩選後的網址、**跳過首頁那一次載入**（實測省下約 2.7–3.1 秒）；讀不到就不能用這個查法，精準搜尋不受影響。這條查法**沒有成交價**：成交紀錄只在單一商品頁，首頁篩選沒有對應的分頁（實測見 `docs/design.md`）。細節與量測結果見 `docs/design.md` 的「Second search」。

## 截圖辨識（擴充功能）

在名稱欄旁貼上、拖入或選擇一張裝備截圖，程式會把最可能的裝備名稱填進名稱欄，其他可能的名稱做成按鈕；**不會自動開始查詢**，要你確認後自己按「開始查詢」。圖片只在你的電腦上處理，不會上傳。

**辨識模型的下載（請先知道）**：辨識程式（PP-OCRv6 small ＋ onnxruntime-web 1.30.0）已經包在擴充功能裡，但三個模型與字元清單沒有。第一次使用會自動下載辨識模型（約 31.8 MB），畫面會顯示進度與取消鈕，從 `www.modelscope.cn` 下載（固定網址、固定版本，下載完會檢查大小與 SHA-256），存在瀏覽器裡，之後可離線使用。下載中可以按「取消下載」；30 秒收不到資料就會停下來，不會自動重試。擴充功能對外連線的只有後端與 `www.modelscope.cn` 兩處。

## 裝備掃描（擴充功能，第三種查法）

線上角色的裝備不在本機存檔裡，用名稱或詞綴都查不到。這個模式改成看畫面：你只要在 Chrome 自己的分享對話框裡選一次 D2R 視窗，然後自己在遊戲裡把滑鼠移到每件裝備上停約半秒，程式就會把裝備提示框（tooltip）裁下來，用同一套截圖辨識讀出名稱，幫你一件一件記下來。

- 程式**不會操作遊戲**：不移動滑鼠、不送出任何按鍵或點擊，也沒有熱鍵；它只讀你分享進來的那張畫面。
- 每件裝備只記一筆，**完全相同的兩件只記一筆**；清單只存在記憶體裡，關掉側邊欄就消失，「清除紀錄」可以清空。
- **識別到一件就自動結束**：清單上多出一筆讀出名稱的紀錄時，掃描會自己結束分享，你不用回來按停止（已經切出來、還在排隊的圖還是會讀完記錄）；「上傳檔案」不受影響。想一次掃整批，把開始鈕下面的「識別到 1 件就自動結束掃描」取消勾選即可。
- 每筆紀錄都有「精準搜尋」、「模糊搜尋」和「TR交易」三顆按鈕。「精準搜尋」和「模糊搜尋」按下去就**直接開始查**：精準搜尋查這筆的名稱；模糊搜尋只帶**底材和品質**（底材用**同一輪讀到的底材候選**，讀到的本身就是底材時用它自己；品質依名稱顏色，黃裝／藍裝／白裝，其他不限），**不帶詞綴條件**，查完可以按「**加詞綴條件縮小範圍**」，這時才會把讀到的詞綴勾好、數字填好（標成「來自擷取」，由你確認或修改）再自己按開始。讀不到底材的紀錄，模糊搜尋只會打開表單等你填底材，不會開始查。精準搜尋沒查到時（例如找不到這個裝備），結果畫面會多一顆「**用詞綴找同類**」，做法一樣。「TR交易」只會幫你填好上架表單，要你按「上架」才送出。查詢結果畫面左上角的「← 掃描清單」隨時回到清單，**不會停止掃描**。你在模糊搜尋裡把底材改成別的再開始查，程式會記住「這筆讀到的文字 → 你改的底材」：下次同樣的文字，模糊搜尋會先把表單打開、用你改的底材（標「照你上次改的底材，請確認」）等你確認；你確認同一個底材第二次之後，就直接開始查。你把讀到的數字改掉（例如 7 改成 8）也一樣會被記住，下次同一行詞綴直接填你改的數字（點狀綠框，不再要你確認）。這些只存在這台電腦，「設定 → 重置」可以逐筆刪除或全部清除。
- 不一定要批量掃描：「上傳檔案」可以一次選一張或多張裝備截圖（只收 png、jpg），每張跟滑鼠停留裁下來的提示框走同一套辨識，同一件只記一筆。
- 掃描清單可以自己下載 CSV，**不需要先跑過任何一次查詢**。
- 第一次使用會自動下載辨識模型（約 31.8 MB，和貼圖辨識共用同一套、只下載一次），畫面會顯示進度與取消鈕。

怎麼用：

1. 載入 `extension/dist`，打開側邊欄就是裝備掃描畫面。
2. 按「選擇遊戲視窗並開始」，在 Chrome 自己的分享對話框裡選 D2R 視窗（這一步只有你自己能做）。
3. 把遊戲切到前景、蓋住 Chrome（建議用「視窗化全螢幕」或視窗模式），在遊戲裡把滑鼠移到每件裝備上，停約半秒。
4. 回到側邊欄看清單；想查某一件，就按那筆的「精準搜尋」或「模糊搜尋」就開始查。

### TR交易（把掃描到的裝備掛到 Traderie）

每筆有名稱的掃描紀錄都有「TR交易」按鈕。按下去會進到上架畫面：裝備名稱（中文（English））、讀到的每一行詞綴（已勾選，讀到的數字填好並用虛線框標成「從擷取讀到，請確認」）、底材類的裝備多一個「品質」（依名稱顏色預填：黃裝／藍裝／白裝）、想換的符文和數量（最多 3 組「或」，或勾「接受出價」）、平台／模式／天梯／版本（先在「設定」裡的「上架預設」選好，這裡還可以改）和數量。什麼都不會送出，直到你按「上架」。按了之後程式用你登入的 Traderie 帳號開商品頁、讀這件物品的資料、送出**一筆**掛單，再到你的掛單清單確認一次；成功會顯示「已上架」和「看掛單」連結，失敗或網站要求驗證時會顯示原因和「到 Traderie 手動上架」按鈕，**不會自動重試**。每按一次「上架」會用掉邀請碼的一次次數（次數用完或邀請碼被拒就不會送出）；整個過程不用 Jev。讀到的詞綴不夠或你想多掛幾條屬性時，可以用「新增上架屬性」自己補上（補的屬性要填數值才能上架，可以用 ✕ 拿掉）；上架成功後，你改過的數字也會被記住（同上，下次同一行詞綴直接填）。

一個已知限制：偵測前會把畫面縮到寬 `480`（`DETECT_WIDTH`）。我們離線量過：把 35 張提示框截圖以原生大小放在 1080p／1440p／4K 的畫面上，偵測會漏掉其中一部分（1080p 漏 8 張、1440p 漏 15 張另有 3 張只框到一部分、4K 漏 31 張，大約 17 %），只框到一部分的裁圖可能少讀幾行。把偵測寬度調高到 720 或 960 也量過，漏掉加只框到一部分的張數只少了 9–15 %，深色地面上還會多出誤框，計算量約 4 倍，所以沒有採用；剩下的漏掉來自偵測方法本身，不是解析度。這些數字來自模擬畫面和截圖，真實的遊戲畫面我們沒有實機驗證過。另外，遊戲蓋住 Chrome 時掃描會變慢、快速掠過的裝備可能漏掉，側邊欄會直接提醒你；建議把遊戲改成視窗模式、和 Chrome 並排。

只有你自己能做的檢查（程式沒有辦法自己跑 D2R）：載入 `extension/dist`，選「裝備掃描」，分享 D2R 視窗，把滑鼠掃過倉庫 10 件裝備、每件停約半秒；預期清單出現 10 筆，名稱以 `中文（English）` 顯示。遊戲蓋住 Chrome 時，側邊欄應該提醒「遊戲視窗蓋住了這個面板…」（此時「每秒畫面」會掉到個位數，這是正常的）；改成視窗模式並排後提醒會消失、「每秒畫面」應回到約 10。「掃描統計」的「略過」是看到了但沒有新增紀錄的件數（同一件再看一次、或讀不出東西），「丟棄」是因為排隊太多而沒讀的件數；狀態列的「待辨識 N 件，約 M 秒」是還要等多久。

## 名稱對照表

`extension/src/traderie/data/items.json` 放「英文名稱 → 商品網址」、「中文 → 英文」和底材清單，是某個時間點的拷貝；查表落空時的備註會顯示它的天數，超過 90 天代表表已過期。表過期的後果只是少了直接開商品頁的捷徑（退回搜尋），不會查錯。

- 檢查現有的表：`uv run python scripts/audit_item_tables.py`（離線；測試也會跑一次）。
- 重新產生（只有 Windows，會開專用 Chrome 讀 Traderie 與 d2r.world）：`uv run --group e2e python scripts/build_item_tables.py`。它先做出候選檔，確認沒有分類消失或縮水超過 10%、也通過上面的檢查，才會取代原本的表。
- `--from-cache` 可以不連網、用 `scripts/data/item_pairs.json` 重建；那個檔要先完整跑一次才會產生，產生後請一併提交。

## scripts 一覽

除了 `traderie.py` 與 `login.py`，下面的工具都在真實 Chrome 或真實網站上執行，只有 Windows 測過；有 `e2e` 的需要 `uv run --group e2e`。

| 檔案 | 用途 | 費用／副作用 |
| --- | --- | --- |
| `scripts/traderie.py` | 命令列查詢（同網頁 demo 的流程） | 呼叫 Jev（付費） |
| `scripts/login.py` | 開出專用 Chrome 讓你登入 Traderie 一次 | 無 |
| `scripts/check_guards.py` | 在本機測試頁檢查瀏覽器安全防護 | 啟動專用 Chrome；不呼叫模型、不連外 |
| `scripts/audit_item_tables.py` | 檢查名稱對照表 | 無（離線） |
| `scripts/build_item_tables.py`（e2e） | 重新產生名稱對照表 | 開專用 Chrome 讀 Traderie 與 d2r.world |
| `scripts/extension_e2e.py`（e2e） | 擴充功能端對端，跑一次真實查詢 | 1 次 Jev 查詢；先關閉專用 Chrome |
| `scripts/extension_batch.py`（e2e） | 批次跑 `scripts/e2e_cases.json` 的案例 | 每案例至少 1 次查詢；要加 `--yes`，邀請碼用環境變數 `JEV_INVITE` |
| `scripts/ocr_e2e.py`（e2e） | 截圖辨識端對端與準確度 | 下載辨識模型；準確度不得低於上次通過的結果 |
| `scripts/scan_e2e.py`（e2e，僅 Windows） | 裝備掃描端對端，跑在替代頁面 `scripts/data/scan_sim.html` 上 | 啟動專用 Chrome；完全不呼叫 Jev、不扣額度 |
| `scripts/demo_e2e.py`（e2e） | demo 頁端對端，用替代伺服器回應 `/api/state` | 啟動 demo 自己的 Chrome；不需要額度、不需登入 |
| `scripts/stub_backend.py` | 零配額的替代後端，讓 `extension_e2e.py --stub-chooser` 不必真的呼叫 Jev | 無（離線；只服務本機） |
| `scripts/probe_stats.py`（e2e） | 量測 Traderie 首頁「Search All Stats」的行為（模糊搜尋查法的依據），並更新兩份測試資料 | 開專用 Chrome 對 Traderie 做唯讀請求；不下單、不呼叫 Jev；需要先登入 |
| `scripts/probe_blocking.py`（e2e） | 量測「封鎖廣告/追蹤主機」對模糊搜尋頁 settle 的影響（同一位址 ON/OFF 交替） | 唯讀、不呼叫 Jev、不扣額度；只寫 `artifacts/blocking/`；需要專用 Chrome（會切換它的封鎖清單） |
| `scripts/_cdp.py` | 上面幾支共用的 Chrome 連線小工具 | — |

## 測試

```bash
uv run ruff check .
uv run pytest                          # 離線，預設不含 live
uv run pytest -m live                  # 真實網站、Chrome、TypeSafe（計費）
node --check src/jev_ultrafast/static/app.js
node --check src/jev_ultrafast/static/csv.js
uv build
```

Agent 每次執行結果並不固定（非決定性）。單次 live 測試失敗（例如搜尋到錯的結果、被網站擋下）不代表程式有 bug，請重跑再判斷。

## 安全與規範（摘自 AGENTS.md）

- 不寫網站專屬的步驟計畫，也不寫死輸入值或點擊目標；模型不產生選擇器或可執行程式碼。
- 永遠不重試瀏覽器的「改動」動作。
- 憑證只放在伺服器端與 `.env`，`.env` 不進版本庫；測試不得呼叫付費 API。
- Agent 選擇 `DONE` 不是成功的證據，結果必須獨立驗證。
- 只讀取，不聯絡賣家、不出價、不離開 Traderie D2R 商品／搜尋頁。
