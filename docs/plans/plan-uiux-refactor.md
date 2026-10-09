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

### Phase 0：契約與量測（S，先做，1 天內）

- **任務 0.1**：把面板的**單一狀態機**寫成契約（`view`、`outcome`、`problem`、`source` 四個欄位就夠）並補 `panel-state.js` 的測試；`deriveView` 已有，補「來源」與「問題」。
  - 檔案：`extension/src/panel-state.js`、`extension/test/panel-state.test.mjs`
  - 驗收：任何 UI 分支都能由這四個欄位決定；測試覆蓋每種組合。
- **任務 0.2**：**問題（problem）單一形狀**：`{ kind, headline, reasons: string[], retry?: string }`，把 `judge`/`judgeStats`/e2e 既有的 reason 文字都塞得進去。
  - 檔案：`extension/src/labels.js`（或新 `problem.js`）、測試。
  - 驗收：舊的三種來源都轉得過去，文字不變（不刪訊息）。
- **任務 0.3**：把 UI 契約寫進 `docs/design.md`（一份「面板介面」小節：模組、輸入輸出、錯誤形狀）——**文件就是契約**。

### Phase 1：兩條搜尋的核心改善（＝既有計畫，進行中）

照 `docs/plans/plan-scan-search-paths.md`：功能 2 已完成；接下來 功能 1（屬性清單先取得）、3（價格摘要）、4（底材來源，待決策 D5）、5–7（掃描加值）、8a（近期成交探測）。
檢查點 A/B/C 依該計畫。

### Phase 2：`sidepanel.js` 解耦（M，本計劃的重點）

把 741 行拆成「純流程 + 細薄綁定」，目標：**同一支不再同時知道 DOM 與業務規則**。

- **任務 2.1**：抽出 `run-name-flow.js`（名稱查詢的流程：開始 → 讀 views → 驗證 → 收尾），純函式收 `{ agent, market }` 與回呼，**不摸 DOM**。
  - 驗收：新模組離線可測；`sidepanel.js` 只剩呼叫與渲染。
- **任務 2.2**：抽出 `run-stats-flow.js`（`stats-query.js` 已是雛形，收斂進去並補測試）。
- **任務 2.3**：把「渲染」集中到 `panel-dom.js`／`result-views.js`，`sidepanel.js` 只做 wiring（事件 → 呼叫 → 渲染）。
  - 驗收：`sidepanel.js` ≤ 300 行；`node --check`、全套測試、實機 e2e 通過。
- **任務 2.4**：`config.js` 依賴只留在一個入口（例如 `api.js`），讓其餘模組離線可測。
  - 驗收：`grep -l "config.js" extension/src` 只剩 1 支；新拆出的模組都能被 `node --test` 直接 import。

### Phase 3：結果層（S～M）

- **任務 3.1**：價格摘要（Phase 1 的功能 3）＋「來源是哪一筆／哪個入口」回連（功能 7）。
- **任務 3.2**：結果表**分頁或上限**（沿用 `MAX_*` 慣例），並在表頭顯示「顯示 N / 共 M」。
- **任務 3.3**：CSV／複製與畫面共用同一組 cells（已經是 `tradingCells`/`statsCells` 的設計，補測試鎖住「三處不漂移」）。

### Phase 4：兩套 UI 收斂（M）

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
