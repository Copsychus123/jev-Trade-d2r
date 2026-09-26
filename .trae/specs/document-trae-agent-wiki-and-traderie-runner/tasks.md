# Tasks
- [x] Task 1: 建立研究基線與交付範圍
  - [x] 盤點 `jev-ultrafast` 現有架構、限制、示例與驗證方式
  - [x] 盤點 `trae-agent` 的公開倉庫結構、核心模組、關鍵類別與運行方式
  - [x] 確認 Traderie D2R 查詢場景中的頁面層級、核心資訊區塊與成功判準

- [x] Task 2: 產出 `trae-agent` 的 Markdown Code Wiki
  - [x] 建立文件骨架，涵蓋專案概覽、架構、模組、類別/函式、依賴、執行與測試
  - [x] 補齊關鍵模組的職責說明與調用關係
  - [x] 補齊主要類別與函式的用途、輸入輸出與在系統中的位置
  - [x] 補齊安裝、配置、執行、開發與測試方式

- [x] Task 3: 定義 Traderie 查詢的最小可行流程
  - [x] 設計一個可接收裝備名稱的輸入介面或示例入口
  - [x] 定義從 Traderie D2R 入口到目標裝備頁面的導航路徑
  - [x] 定義如何取得 `Trading` 與 `Recent Trades` 的觀測與提取結果

- [x] Task 4: 補強 `jev-ultrafast` 以支援 Traderie 場景
  - [x] 若 Traderie 控件或頁面結構超出目前觀測能力，補強快照或執行層
  - [x] 若需要更穩定的決策或提取，補強代理流程、輸出資料結構或示例腳本
  - [x] 保持站點無關原則，不引入硬編碼 selector、站點腳本或不可驗證捷徑

- [x] Task 5: 建立獨立驗證與結果輸出
  - [x] 實作成功條件驗證，確認裝備名稱、目標頁面、`Trading`、`Recent Trades` 同時成立
  - [x] 產出人類可讀且機器可消費的查詢結果
  - [x] 在失敗時輸出可定位問題的上下文與證據

- [x] Task 6: 補齊測試與驗證
  - [x] 新增或更新聚焦測試，覆蓋 Traderie 查詢與結果驗證的關鍵行為
  - [x] 執行 `uv run ruff check .`
  - [x] 執行 `uv run pytest`
  - [x] 執行 `node --check jev_ultrafast/static/app.js`
  - [x] 執行 `uv build`

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 3
- Task 5 depends on Task 4
- Task 6 depends on Task 2, Task 4, and Task 5
