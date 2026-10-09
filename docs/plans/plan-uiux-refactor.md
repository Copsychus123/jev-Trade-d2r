# 計劃：業務邏輯與 UI/UX 重構（專案層級）

狀態：**待你確認。** 與 `docs/plans/plan-scan-search-paths.md`（兩條搜尋的核心改善）並存——那份是**本計劃的 Phase 1**，進行中（功能 2 已完成並提交 `7cc08c3`／`cfc272a`），本計劃不覆蓋它。

## 一、為什麼要重構（量到的現況）

| 事實 | 數字 | 為什麼是問題 |
|---|---|---|
| `extension/src/sidepanel.js` | **741 行**，且是**唯一**匯入建置產物 `config.js` 的模組 | 面板的狀態機、事件綁定、流程編排全擠在一支裡；離線**不可測**（34 支單元測試沒有一支 cover 它） |
| 面板 UI 與 demo UI | 面板：`panel-dom.js`+`result-views.js`+`sidepanel.css`；demo：`app.js` 679 + `style.css` 1143 + `index.html` 190 = **2,032 行** | **兩套 UI、兩套渲染、兩套信任線/表格**，同一個產品卻沒有共用視覺語言與規則 |
| 已證明有效的樣式 | `stats-form-state.js`（99，純）、`scan/session.js`（145，純）、`panel-state.js`（39，純）都有測試 | 純核心 + 細薄 DOM 這條路本專案走得通，應該推廣到 `sidepanel.js` |
| 錯誤／狀態的表達 | `banner`、`status`、`reason`、`view`、`kind`、`failed_checks`、`rule_events`… 多套並存 | 消費者（UI、報告、CSV、e2e）各自解讀，容易漂移 |
| 清單 | 掃描紀錄記憶體上限、`MAX_CANDIDATES`、`MAX_CONDITIONS`、`MAX_ACTIONS` 都有；**結果表**沒有分頁概念 | 一次讀 150 筆掛單時，UI 直接全畫 |

## 二、原則（本次重構不變的規則）

1. **契約優先**：每個新模組先寫下輸入／輸出／錯誤（形狀與責任），再寫實作；契約放進模組 docstring 與測試的斷言裡。
2. **錯誤語意一致**：面板對「問題」只有一種呈現（`{kind, headline, reasons, retry}` 這種單一形狀），不再讓各處自組 banner。
3. **新增而非修改**：對外可見的欄位一律 additive（`record.base`、`row.fromCapture` 已是先例）。
4. **清單一律有界**：任何 render 的清單都要有上限或分頁（沿用 `session.MAX_QUEUE` 的精神）。
5. **不加 LLM 呼叫、不做 LLM 資料分析、兩顆搜尋按鈕只預填不查詢。**
6. **Chrome e2e 家族一次一支。**

## 三、心智模型（UI/UX 的北極星）

```
入口（玩家手上的東西）            搜尋（核心業務）                 結果
① 打名字        ┐
② 貼／放截圖     ├──▶  精準：這件值多少  ──▶  掛單（全部）+ 近期成交 + 8 項驗證
③ 掃描 hover     │                              └─▶ 價格摘要（最低／中位／四分位）
④ 手勾條件      ┘     模糊：這種詞綴值多少 ──▶  首頁 filter 掛單（第一頁）
                                                  └─▶ 價格摘要 + 「來源是哪一筆」
```

現況的三個落差：**入口沒有被看見**（玩家不知道自己從哪裡來、也不知道已經有什麼被讀到）、**兩條搜尋沒有被區分**（同一畫面兩種模式，切換靠記憶）、**結果沒有結論**（表格自己看）＋**結果不指回來源**。

## 四、分階段計畫

### Phase 0：契約與量測（S，先做，1 天內）— **部分完成**

- **任務 0.1 — 部分完成**：`affixHandoff(shown, source, ended)` 已從 DOM 碼抽成 `panel-state.js` 的純函式（7 案例）；`deriveView`／`visibleSections` 本來就是純的。**面板那組 flat `let`（`market`/`after`/`banner`/`runSource`/`quota`/分頁…）的收斂要等 D1**——沒有 D1 就不該先動狀態形狀。
- **任務 0.2（單一 problem 形狀）— 延後**：它會動到被多個測試斷言的 reason 文字（`judgeStats`／`judge`／`explainFailedChecks`），屬於「有改動風險的中等重構」，應與 D1／D2 一起決定。
- **任務 0.3 — 已完成**：面板契約寫進 `docs/design.md` 的「The side panel's screens and state (extension)」小節（四個事實 → `VIEWS`／`SECTIONS`、兩個純決策、cells 以欄位名稱取值、以及「唯一 import `config.js` 的模組」這道可測性牆）。

### Phase 1：兩條搜尋的核心改善（＝既有計畫，進行中）

照 `docs/plans/plan-scan-search-paths.md`：功能 2 已完成；接下來 功能 1（屬性清單先取得）、3（價格摘要）、4（底材來源，待決策 D5）、5–7（掃描加值）、8a（近期成交探測）。
檢查點 A/B/C 依該計畫。

### Phase 2：`sidepanel.js` 解耦（M）— **切片 1 完成；切片 2／3 查證後不建議，停在這裡**

- **切片 1（已完成，`a1d7a01`）**：把**名稱查詢的結果判斷**（`judge`：guard／not_found／blocked（有無 guard 頁）／blocked view／done，以及 `describeError`：被拒的邀請碼／執行中失敗／查詢視窗被關）搬到純模組 `extension/src/run-outcome.js`。呼叫端傳事實（stopped／outcome／status／scope reason／page／tab／market／itemName）並**注入**兩個會碰頁面與 controller 的東西（`detectGuard`、`verify`）；驗證結果由面板套用，`market.verification` 的寫入時機與原本一致。**12 個新測試**涵蓋每一種畫面。
- **切片 2 — 查證後：沒有東西可收斂，取消**。原計畫以為要「收斂 `runStatsQuery`」，但 `runStatsFlow`（`stats-query.js` 171 行）與 `judgeStats` 早已在該模組；面板那段只是**6 行轉接**（`begin`／`setStatus`／`render`／`shouldStop` 四個 hook ＋ 指派 `itemName`）。搬走它＝把同樣的複雜度換位置。
- **切片 3 — 評估後：不建議做**。最大的候選是 `start()` 內的名稱流程工作函式（finder 的選項物件），但它依賴 `API_BASE`（建置產物 config.js）、`findAndRead`、`startRun`／`chooseNext`、`searchShowsItem`、`phaseFinishRule`、`Agent`／`newCallBudget` 六項以上；要讓它離線可測就得把這些全部注入，**讀者要同時持有的概念數不變**，而驗證仍只能靠 Chrome e2e。依「重構要讓分支消失、不是搬家」的原則，停在切片 1。
- **目標修正**：原計畫寫「`sidepanel.js ≤ 300 行」是**任意的行數指標**。剩下的 785 行裡約 200 行是 `render*`（計畫本來就說留在面板）、約 150 行是初始化與事件綁定；真正的業務規則（判斷樹、兩種搜尋的流程、cells 對應、狀態機）**都已經在可測的模組裡**。所以判準改成**概念數**，不是行數。
- **驗證方式（切片 1 用它驗過）**：`node --test` ＋ **零 Jev** 的 `scripts/extension_e2e.py --stub-chooser`（實測 exit=0：6 樣本成功／0 失敗、150 掛單／20 成交、0 次 Jev 呼叫）。

把 741 行拆成「純流程 + 細薄綁定」，目標：**同一支不再同時知道 DOM 與業務規則**。

- **任務 2.1**：抽出 `run-name-flow.js`（名稱查詢的流程：開始 → 讀 views → 驗證 → 收尾），純函式收 `{ agent, market }` 與回呼，**不摸 DOM**。
  - 驗收：新模組離線可測；`sidepanel.js` 只剩呼叫與渲染。
- **任務 2.2**：抽出 `run-stats-flow.js`（`stats-query.js` 已是雛形，收斂進去並補測試）。
- **任務 2.3**：把「渲染」集中到 `panel-dom.js`／`result-views.js`，`sidepanel.js` 只做 wiring（事件 → 呼叫 → 渲染）。
  - 驗收：`sidepanel.js` ≤ 300 行；`node --check`、全套測試、實機 e2e 通過。
- **任務 2.4**：`config.js` 依賴只留在一個入口（例如 `api.js`），讓其餘模組離線可測。
  - 驗收：`grep -l "config.js" extension/src` 只剩 1 支；新拆出的模組都能被 `node --test` 直接 import。

### Phase 3：結果層（S～M）

- **任務 3.1 — 已完成**：價格摘要（`7282391`）與「來源是哪個入口／哪一筆」回連（`a8a9029`），細節見 `plan-scan-search-paths.md` 的功能 3／7。
- **任務 3.2 — 查證後：已經存在，不用做**。`sidepanel.js` 早就用 `paginate.js`（`PAGE_SIZE`／`clampPage`／`pageCount`／`pageRows`）、顯示「第 N / M 頁」，且 `total <= PAGE_SIZE` 時整個分頁器隱藏。原計畫是在沒查證的情況下寫的（本計畫已有兩項如此：功能 1、這項）。若還想要「共 M 筆」的字樣，那是文案層的小改。
- **任務 3.3 — 查證後：已經滿足，不需要測試**。`rows.js` 以**欄位名稱**取值（`reader(head, cells)`，缺欄位時 throw），而 `rows.test.mjs` 已經釘住「the listing layout uses every column of the table, so a new column cannot be left off the screen」「every cell the CSV gets also reaches the two-line row」「a missing column is an error instead of a silently empty row」（stats／recent 各有一條對應）。原計畫的「三處不漂移」測試會是重複的。

### Phase 4：兩套 UI 收斂（M）

- **任務 4.2（資料／文字規則）— 部分完成**（`0bb2057`）：查證發現兩邊**真的漂移**——demo 的掛單表 6 欄、成交 3 欄，面板（與其 CSV）是 7 欄與 5 欄；同一份 `market.json` 用 demo 匯出會**少掉 `遊戲版本`（兩個視圖）與成交的環境欄**。已把 demo 的 `head`／`cells` 對齊面板的 `TRADING_COLUMNS`／`tradingCells`、`RECENT_COLUMNS`／`recentCells`，並用 `extension/test/columns-parity.test.mjs` 釘住（兩檔無法共用程式碼 → 測試當契約，與 `tests/test_run_budgets.py` 同型）。變異驗證：拿掉一欄測試立刻紅。**限制**：只比標籤與順序，不比 cell 值（demo 的 cells 是行內 lambda；寫在測試 docstring 裡）。
- **任務 4.2 續 — 已完成**（`c8aaf11`）：demo 原本把 **`failed_checks` 的原始 id** 印給玩家（「檢查未通過：…；same_product、recent_rows_ok」），違反 repo 自己「白話繁中、不要術語」的規則。現在改用與面板相同的句子（各說一次、依失敗順序），句子由 demo **自帶一份**（兩邊無法共用程式碼），並用 `extension/test/check-reasons-parity.test.mjs` 釘住（變異驗證：改一句立刻紅並列出兩邊）。
- **任務 4.1（視覺 token）— 仍待你決定**：兩套樣式（demo `style.css` 1,143 行 vs `sidepanel.css`）共用顏色／間距／表格樣式是**美學**決定。我看得到 demo 的靜態頁（可截圖給你看），但不該替你挑配色。**建議**：先讓我截兩邊現況，你指一套為基準，再改。

- **任務 4.1**：抽出共用視覺（顏色 token、表格、信任線、badge）到單一 CSS 來源，demo 與面板都吃它（demo 目前 `style.css` 1,143 行與面板的樣式各自長）。
- **任務 4.2**：demo 的渲染規則改吃同一組 cells/`verificationSummary`（目前 demo 有自己的一套），讓「同一份資料在任何 UI 都長一樣」。
  - 驗收：兩邊對同一份 market 產生相同的欄位與文字；`tests/test_ui_static.py` 與新測試通過。

### Phase 5：收尾（S）

- 更新 `docs/design.md`（模組圖、契約、錯誤形狀）、`AGENTS.md` 對應段落；跑一次完整驗證（`pytest`／`node`／`ruff`／`build.py`／實機 `ocr_e2e`＋`scan_e2e`）。

## 五、檢查點

| 檢查點 | 內容 |
|---|---|
| 0 後 | 狀態機與問題形狀的測試綠；`docs/design.md` 有「面板介面」小節 |
| 1 後 | ＝既有計畫的檢查點 A/B |
| 2 後 | `sidepanel.js` ≤ 300 行；新模組有單元測試；`config.js` 只有 1 個入口；實機 `extension_e2e`＋`scan_e2e` 綠 |
| 3 後 | 摘要／來源／分頁在實機看得到；CSV 與畫面一致 |
| 4 後 | demo 與面板同一份資料同一個樣子 |

## 六、需要你決定

1. **D1**：Phase 2 要不要做？（這是最大的一刀：741 行的解耦。價值＝可測試與可維護；成本＝要動實機驗證）
2. **D2**：**兩套 UI 收斂**（Phase 4）要到什麼程度？（①只共用視覺 token；②共用 cells/文字規則；③只留一套 UI）
3. **D3**（沿用）：唯一物品的底材來源（`plan-scan-search-paths` 的 D5）。

## 七、風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 拆 `sidepanel.js` 動到實機才驗得到的行為 | 高 | 每拆一支就跑 `node --test` + `extension_e2e --stub-chooser`（零額度）；一次一支、可回退 |
| 兩套 UI 收斂改到 demo 的使用者體驗 | 中 | 先共用 token，再共用文字規則；每步保留舊畫面截圖對照 |
| `config.js` 依賴改動讓打包壞掉 | 中 | `extension/build.py` 與 `tests/test_extension_build.py` 已存在，動完立刻跑 |
| 與 Phase 1 的檔案重疊 | 低 | Phase 1 先完成（同一批檔案），Phase 2 才開始 |

## 八、這份計劃不包含

- 不改「只預填、不查詢」「不加 LLM」「e2e 序列化」等既有規則。
- 不改 `items.json` 資料形狀、不改 Traderie 導覽規則（查表跳轉／`stripToBase`／stats URL）。
- 不做視覺重設計（只做收斂與一致性）。
