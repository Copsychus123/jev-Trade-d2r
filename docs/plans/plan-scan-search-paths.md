# 計劃：精準搜尋與模糊搜尋怎麼服務得更好（掃描只是便民入口）

狀態：**進行中。** 依 repo 慣例放 `docs/plans/`（本 repo 不使用 `tasks/todo.md`）。

> **定位修正（你 2026-10-09 指示）**：分享 D2R 視窗**不是必經步驟**，只是便民入口；**核心業務是「精準搜尋」與「模糊搜尋」本身**。因此本計劃把「與入口無關的核心改善」排在最前面，掃描相關的只當加值。

## 一、為什麼要做

兩條搜尋目前各有核心摩擦，且**與入口無關**（不論玩家是打字、貼圖、還是掃描來的）：

- **模糊搜尋對唯一／套裝／符文之語無法開始**：`startBlocker` 要求底材非空（`stats-form-state.js:94`），而唯一物品的 tooltip **不含底材名**。任何入口（手打、截圖、掃描）都會撞到同一堵牆。
- **數值要一顆一顆手打**：`fillFromScreenshot` 一律留 `min/max = null`（`stats-form-state.js:32-42`），每條勾選的非 bool 條件都要有值（`:91-92`），即使畫面上明明寫著 `+141 Defense`。
- **無法對應的詞綴是靜默忽略的**：玩家按下開始後才在 `judgeStats` 收到「這些條件 Traderie 沒有對應的屬性」而整筆結束。
- **兩條路互不相通**：精準失敗（商品找不到／game-only／中文不在表）不會提示「改用詞綴找同類」；模糊查完也沒有價格結論，只有一張要自己看的表。

## 二、四個入口，兩條搜尋（核心模型）

```
入口（玩家手上的東西）                搜尋（核心業務）
────────────────────────────      ───────────────────────────────
① 打一個名字（中/英）          ┐
② 貼／放一張截圖（📷 讀詞綴）   ├──▶  A. 精準搜尋：我這件值多少
③ 掃描 hover 到的裝備（便民）   │      三層 finder → 全部掛單 + 近期成交 → 8 項驗證
④ 自己勾條件（表單）           ┘       成本：Jev 額度（上限 30/run）
                              └──▶  B. 模糊搜尋：這種詞綴值多少
                                     條件 → home page filter URL → 首頁掛單 → 5 項檢查
                                     成本：0（純規則、無後端、無 Jev）
```

**兩顆按鈕只是入口 ③ 的兩個捷徑**；同一組核心改善要對四個入口都成立。

## 三、玩家路徑（理想版）

1. **入口**：打字／貼圖／掃描／手勾條件——四者都只**預填**表單，永不自行查詢。
2. **精準（A）**：確認名稱 → 按「開始查詢」→ 查表跳轉／站內搜尋／底材清單 → 全部掛單 + 近期成交 → 8 項驗證。
   - 失敗（找不到商品／game-only／中文不在表）→ 就地給「**用現在的條件找同類**」（條件已從任一入口帶進來）。
3. **模糊（B）**：底材**有人幫你決定**（見功能 1／決策 D5）→ 詞綴已勾、**數值已預填並標記「請確認」** → 無法對應的詞綴**已先剔除並列出** → 按「開始查詢」→ 首頁 filter 掛單。
4. **結果**：價格摘要（最低／中位／四分位，依 High Rune Value）＋（若來自掃描）標明是哪一筆紀錄。可選：同一組條件的近期成交。

## 四、會完成的功能與測試方法

### 核心（與入口無關，先做）

#### 功能 1：無法對應的詞綴先剔除並列出（S）— **已完成，範圍縮小後實作**（`1f75022`）
> 查證後發現「剔除並列出」大部分已存在（`setOn` 對 `unavailable` 的 key 一律拒絕；`judgeStats` 會列出並請玩家再查一次）。真正的缺口只有「第一次查詢前不知道屬性清單」。實作改成 `properties.ensureProperties`：**新鮮快取不開分頁**、舊副本才讀一次（開一個分頁、`finally` 關閉）、失敗丟錯（**不用舊副本**）；面板的 getter 是 best-effort（catch 後回 null，填表照舊）。3 個新測試。
>
> **實機發現（重要）**：填表是 **async** 的，而 e2e 每次都清 profile → 第一次填表要真的去讀 742 項屬性，固定 0.3 秒的快照會看到**空表單**（`ticks: 0`）。兩處修正：①把暖機提前到**玩家切到模糊搜尋模式時**（`b35e313`，fire-and-forget，把延遲藏在玩家動作後）；②e2e 改成**等「詞綴清單出現列」**（上限 25 秒）而不是等固定時間（`75fa08a`）。
> **實機證據**：`scan_e2e` exit=0（`fuzzy_item {ticks 1, statsBase 'Sacred Rondache', statsBaseFrom 'ocr'}`、`fuzzy_base {ticks 1, statsBase 'Grand Charm'}`）；`ocr_e2e` exit=0（詞綴組 `values_filled/values_marked true`、`marked: 1`、閘門 開→清空關（理由正確）→填值開；準確度 22/21/22、30/22/29 未變；下載組 13 項全 true）。
> **排除的假設**（離線實驗）：`unmappedKeys(normalizeProperties(fixture))` 是 **[]**，四個紀錄的詞綴鍵都對應得到 → 不是「被拒絕勾選」造成的。
**檔案**：`extension/src/stats-form-state.js`（`fillFromScreenshot` 回傳／記錄被略過的標籤）、`extension/src/stats-form.js`、`extension/src/sidepanel.js`＋`sidepanel.css`（表單旁一行「已略過 N 條：…」）。
**實作縮小（2026-10-10 稽核確認）**：出貨的不是那一行彙總，而是**每一列自己的註記**——`stats-form.js` 對 Traderie 沒有對應屬性的條件印「（Traderie 沒有這個屬性）」並把該列變灰、勾選框停用（`stats-form-state.js` 的 `setOn`／`fillFromScreenshot` 也會拒絕把它打開），`sidepanel.css` 有 `.affix.unmapped`。語意相同、位置不同。
**驗收**：任何入口帶進來的詞綴，若 Traderie 沒有對應屬性，就不被勾選、且被列在表單旁；按開始不會再被 `judgeStats` 的 unmapped 分支中止（前提：剩下的條件有值）。
**驗證**：`node --test extension/test/stats-form-state.test.mjs extension/test/panel-state.test.mjs`；`uv run pytest`；實機 `scripts/ocr_e2e.py`（截圖入口）與 `scripts/scan_e2e.py`（掃描入口）。
**相依**：無。

#### 功能 2：數值預填但標記（S，**你已同意：要**）— **已完成**（`7cc08c3` 功能、`cfc272a` e2e、`cbeb900` 只標記有值的那一格）
**檔案**：`extension/src/stats-form-state.js`（`fillFromScreenshot` 的 `{ carryValues }`）、`extension/src/stats-form.js`、`extension/src/sidepanel.css`（`.from-capture`）、`scripts/ocr_e2e.py`（詞綴組改量測新行為）、`tests/test_e2e_scripts.py`。
**驗收（已達成）**：只預填擷取到的數字；只有**真的有值**的那一格加上 `.from-capture` 與「從擷取讀到，請確認」；玩家自己打過的數字不會被後續讀取覆蓋；**仍需玩家按開始查詢**。
**實機證據**（`artifacts/ocr-e2e/report.json`，19:29，exit 0）：`values_filled: true`（`min: "11"`）、`values_marked: true`、`start_gate_after_capture: {disabled:false}`（擷取到的值就開了閘門）、把每一格透過頁面清空後 `start_gate_after_clearing: {disabled:true, whyVisible:true}` 且理由為「有勾選的條件還沒填數值：冰寒抗性」、補回一個值後 `start_enabled_after_value: {disabled:false}`。`scan_e2e.py` 19:34 exit 0（`fuzzy_item.ticks 1`、`fuzzy_base.ticks 3`）。準確度未受影響（22/21/22、30/22/29）。
**已完成（2026-10-13 重跑確認，實機）**：`uv run --group e2e python scripts/ocr_e2e.py` **exit 0**（615 秒）。標記粒度在實機成立：詞綴組 `values_filled: true`、`values_marked: true`（只有真的帶值的那一格被標記）、開始閘門有值時開（`disabled: false`）、清空後關並顯示理由（`whyVisible: true`）、補值後再開（`disabled: false`）且全程 `no_query_started: true`。準確度與門檻一致：調校組 top-3 **22/22**、保留組 **29/30**；下載組 13 項與自動辨識組 4 項全 True。報告寫入 `artifacts/ocr-e2e/report.json`（通過才會覆蓋基準）。

#### 功能 3：模糊搜尋結果的價格摘要（S）— **已完成**（`7282391`）
`traderie/price-summary.js`（純）：High Rune Value 的最低／中位數／四分位（nearest-rank；`priced < 4` 不給四分位）＋未標價計數，不改動 rows；`labels.priceSummaryLine` 產出單句，`renderChrome` 把它放在結果註記行最前面（模式為 stats 時）。**注意**：parser 寫的是 `high_rune_value`（snake_case），模組兩種都讀。
**驗證**：離線 8＋4 個案例綠；**實機未斷言**——這條路徑只在真的查詢後才出現，要驗得跑 `scripts/extension_e2e.py`（會花真實 Jev 額度），留到下一次額度驗證時一起看。**你 2026-10-10 決定：先不跑**，所以這一條仍是離線＋`scan_e2e`／`ocr_e2e` 覆蓋。
**檔案**：新純函式（`extension/src/traderie/stats.js` 或 `price-summary.js`）、`extension/src/panel-dom.js`、測試。
**驗收**：對已讀 rows 給最低／中位數／四分位（略過無法解析者並計數）；空清單顯示「沒有可比較的價格」；**排序鍵用 High Rune Value**（你的決定）；無模型、無額度。
**驗證**：純函式單測（`Unknown`／複合價格／空清單／單筆）＋ `node --test` ＋ `pytest`。
**相依**：無。

#### 功能 4：唯一物品的底材怎麼來（M，**需你決定 D5**）— **已完成（採選項 ②：底材建議清單）**（`0889788`）
**決定**：維持「底材必填」的既有規則（不動 `startBlocker`），改成**讓填得出來**——`#stats-base` 接一個 `<datalist>`，選項來自**出貨表**（`lookup.baseOptions(indexTables)` → `items.json` 的 `bases`，因此沒有任何底材名稱寫在程式裡），在玩家切到模糊搜尋模式時填入（best-effort，與屬性暖機同一個時機）。**是建議、不是限制**：玩家仍可自由輸入。
**驗收（離線已達）**：`baseOptions` 3 個案例（null／空／去重保序）＋ `scan_e2e` 新斷言（datalist ≥ 50 個選項，並有對應的離線失敗案例）。**實機斷言已在 `scan_e2e` 通過**（`#stats-base-options` ≥ 50；2026-10-10 exit 0）。
**問題**：`startBlocker` 要底材，而唯一物品（任何入口）都沒有底材可讀。
**選項**：①**由品質代替**（用 `prop_<quality>=<value>` 當篩選，底材留空；需改 `startBlocker` 的規則）②保留必填，但提供**底材建議清單**（從 `items.json` 的 bases 取，打字時過濾）③只在「同一趟精準搜尋已經找到該商品」時自動帶入底材（該頁的標題含底材時）。
**驗收**（依選項而定）：唯一物品從任一入口都能在**不靠遊戲知識**的情況下開始模糊搜尋。
**驗證**：純函式／狀態單測 ＋ 實機。
**相依**：D5 決定後才動。

### 加值（入口 ③ 掃描專屬）

#### 功能 5：掃描紀錄帶上底材候選 → 模糊搜尋自動預填（S）— **已完成**（`b2c6b64`）
`scan/session.js` 匯出純函式 `baseCandidate(candidates)`（第一個 `kind === "base"`），`addRecord` 存 `base`，`scan-panel.js` 把同一輪 `ocr.match(text)` 的候選交進去；`onSearchStats` 對非底材紀錄用 `record.base` 預填（`setBaseFromScreenshot` 仍不覆蓋玩家自己打的值、並標記來自擷取）。
**檔案**：`extension/src/scan/scan-panel.js`（`:124` 已算出 `ocr.match(text)` 的完整候選，現在只取 `[0]`）、`extension/src/scan/session.js`（`addRecord` 多存 `base`）、`extension/src/sidepanel.js`（`onSearchStats`）。
**驗收**：唯一物品的紀錄按下模糊搜尋後底材欄已填（欄位標記為「來自擷取」可改），無候選時維持原本提示；CSV 欄位與既有紀錄不變。
**驗證**：`node --test extension/test/scan-session.test.mjs`（候選挑選的純函式）＋ `pytest` ＋ 實機 `scan_e2e.py`。
**相依**：功能 4 的決定會影響它（若選 ①，這裡的預填只是錦上添花）。

#### 功能 6：精準失敗 → 一鍵轉模糊（S）— **已完成**（`a8a9029`，與功能 7 同一筆：共用「來源」機制）
`#part-summary` 多一顆 `#fuzzy-handoff`（「用詞綴找同類」），只在**這次查詢來自掃描紀錄**且畫面處於 `requery` 時出現，按下去就是 `onSearchStats(runSource.record)`（與掃描清單那顆同一條路）。**實機未斷言**：需要一次「精準失敗」的實跑（花額度），留到額度檢查點——**你 2026-10-10 決定：先不跑**。
**檔案**：`extension/src/sidepanel.js`（失敗訊息旁一顆按鈕，帶入目前的條件）。
**驗收**：精準以「找不到這個裝備」或 game-only 收場時出現「用這些詞綴找同類」，按下切到詞綴模式且條件已勾。
**驗證**：`node --test extension/test/panel-state.test.mjs` ＋ 實機 ＋ 人工看一次。
**相依**：無（但功能 4 決定它按下去會不會卡在底材）。

#### 功能 7：結果頁回連「這次查詢來自哪個入口／哪一筆」（S）— **已完成**（`a8a9029`）
面板記住本次查詢的來源（掃描的兩顆按鈕、以及讀圖時設定；玩家按「重新查詢」或重新選模式時清掉），`labels.sourceLine` 產生一句「來源：掃描紀錄 12:34 · 防禦、打擊恢復」或「來源：截圖」，`renderChrome` 把它放在價格結論之後、既有 lookup 註記之前。打字進來的查詢不顯示（null）。5 個離線案例。
**檔案**：`extension/src/sidepanel.js`（記住來源：打字／截圖／掃描第 N 筆）、`extension/src/panel-dom.js`。
**驗收**：同一件裝備各查一次精準與模糊，兩個結果頁都指回同一來源（掃描來的話含時間／詞綴）。
**驗證**：`panel-state` 測試 ＋ 實機。
**相依**：無。

### 可選（工程量大，先探測）

#### 功能 8：模糊搜尋也讀近期成交（L → 8a 探測／8b 讀取／8c 呈現）— **8a 完成：不可行，8b／8c 取消**（探測 `da28156`）
**事實**（專用 Chrome 已登入，2026-10-09，已寫進 `docs/design.md` 的探測清單）：帶 filter 的首頁 **1037 個連結裡沒有任何一個通往近期成交分頁**、頁面只有掛單標記（`Make an Offer`）；把商品頁在用的 `/recent` 寫法套上同一組 filter（`/diablo2resurrected/recent?prop_520Min=1`）會落到 HELP 頁尾、**0 筆、無成交標記**；真正的成交價**只存在於商品頁**的 `They Give` 區塊（對照組 B 讀到 `They Give`＋`1 X Ist Rune`）。
**結論**：模糊搜尋這條路徑**沒有成交價的資料來源**，「要價 + 成交價」在此不成立 → 8b／8c 取消。日後若要成交價，唯一方向是**先鎖定單一商品**（也就是回到精準搜尋那條路）。
**探測腳本注意**：`scripts/probe_stats.py` 會**改寫 tracked 的 `tests/fixtures/home_stats.txt`**（本次執行後已還原到 HEAD）；要刷新那份 fixture 請**單獨提交**，不要讓它混在功能提交裡。
**8a（read-only，S）**：`scripts/probe_stats.py` 實測「同一組 filter URL 是否存在 `/recent` 分頁、頁面文字是否含成交」。
**驗收**：產出「可／不可＋實測 URL 與頁面片段」，不寫死假設。
**相依**：8a 擋 8b、8c。

### 檢查點
- **A（核心 1–3 後）**：`node --test "extension/test/*.test.mjs"`、`uv run pytest`、`uv run ruff check .` 全綠；實機 `ocr_e2e.py` 與 `scan_e2e.py` 各一次（序列化）；人工看「截圖入口按模糊搜尋 → 能直接開始」。
- **B（功能 4–7 後）**：同上，另加「唯一物品不靠遊戲知識能開始模糊搜尋」「精準失敗→轉模糊」「結果指回同一來源」。
- **C（8a 後）**：看事實再決定 8b／8c。

> **驗證方式更正（重要）**：`python script.py | tee log` 的退出碼是 **tee 的**，不是腳本的。先前幾次回報的「exit 0」因此不可靠（當時的判定是靠 report 內容，結論仍成立）。之後一律寫成 `python script.py > log 2>&1; echo "exit=$?"`。

## 五、需要你本人做的事

1. 決策 D5（唯一物品的底材來源）——這是核心那一項的唯一卡點。
2. 實機驗證時**由你在遊戲裡 hover**（遊戲**就裝在這台機器上**，實查 `C:\Program Files (x86)\Diablo II Resurrected` 存在；但啟動遊戲、登入角色、把滑鼠移到裝備上這三件事必須由人操作 —— 掃描程式本身不碰滑鼠也不送輸入，`scan_e2e.py` 只能用替身頁面驗流程）。步驟：
   1. 開著 D2R，把要檢查的角色**登入到遊戲裡**。
   2. 在 Chrome 開側邊欄 → 選「**裝備掃描**」→ 按「**開始掃描**」→ 在 Chrome 的分享視窗裡選 **D2R 的視窗**（不是螢幕，也不是分頁）。
   3. 滑到一件裝備上**停住約 1 秒**（tooltip 要完全出現），再換下一件；每 hover 完一件，側邊欄應該多一筆紀錄（名稱 ＋ 類型／詞綴兩行）。
   4. 全部 hover 完按「**停止掃描**」→ 按「**下載 CSV**」。
   **成功的樣子**：每件 hover 過的裝備各一筆、完全相同的兩件只記一筆、CSV 打得開。
   **失敗時告訴我哪一種**：①完全沒紀錄（畫面／縮放問題，或分享到錯誤的來源）；②有紀錄但名稱不對（辨識或比對問題）；③只有部分裝備沒紀錄（tooltip 出現太快或沒停住）。這三種我都能從你的描述直接定位。

## 六、這份計劃不包含的東西

- 不改「只預填、不查詢」。
- 不新增 LLM 呼叫、不做 LLM 資料分析、不讓模型產生欄位文字。
- 不改 `items.json` 的資料形狀（不新增「物品→底材」欄位）。
- 不動 Chrome e2e 的序列化規則。

## 七、我確認過的事實（含位置）

- `stats-form-state.js:46-47` 預填的條件不帶數值（`carryValues` 時才沿用讀到的 `min/max`）；`:60` 手動新增的列一律 `min/max = null`；`:93-95` 底材空→「請輸入底材名稱」、勾了非 bool 沒值→「有勾選的條件還沒填數值」；`emptyStatsForm().base === ""`。
- `scan-panel.js:37` 已算出完整候選（只取 `[0]`）；`:46-47` 紀錄存的是讀取當下的 `base`／`conditions`，而表單每次從 `record.text` 重算（兩個真相來源）。
- `sidepanel.js:549-556` 精準只填名稱；`:558-566` 模糊預填底材（紀錄自己是 base 就用它的名稱，其餘用同一次讀取的底材候選）。
- `sidepanel.js` 匯入**建置產物** `config.js`：離線測試要先用註冊的 resolve hook（`extension/test/support/stubs.mjs`）才 import 得到，真瀏覽器裡的路徑仍由 `ocr_e2e`／`scan_e2e` 守著。

## 八、風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| 功能 2 預填錯數字 → 玩家照著查 | 中 | 只填單純整數、標記待確認、仍需人按開始；單測覆蓋「不預填」態 |
| 功能 4 選 ①（品質代替底材）會放寬既有規則 | 中 | 它是你的決定；先寫測試再改，並在 AGENTS.md 補一句 |
| 功能 5 的底材候選可能不是該商品的底材 | 中 | 欄位標記「來自擷取」可改；`setBaseFromScreenshot` 不會覆蓋玩家已輸入的值 |
| 價格摘要的排序鍵 | 低 | 已定為 High Rune Value；無法解析者略過並計數 |
| 實機 e2e 互相撞 | 低 | 一次一支、序列化 |

## 九、未解問題

1. **D5 已定案**：唯一物品的模糊搜尋底材＝**②底材建議清單**（最不動規則、任何入口都適用：①品質代替要改規則、③只在精準先跑過才有用），已實作於功能 4（`0889788`）。
2. **功能 8 已定案**：探測（`da28156`）證實模糊搜尋的詞綴篩選頁沒有近期成交視圖，**不可行 → 8b／8c 取消**。
