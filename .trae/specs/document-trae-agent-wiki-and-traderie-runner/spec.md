# 產出 Trae Agent Code Wiki 並規劃 Traderie 查詢流程 Spec

## Why
目前缺少一份能讓工程師快速理解 `trae-agent` 倉庫的結構化 Code Wiki，閱讀成本高且不利於後續維護與二次開發。  
同時，`jev-ultrafast` 雖已展示通用瀏覽器代理能力，但尚未驗證其在 `Traderie` 這類真實交易站點上，能否以站點無關的方式完成 D2R 裝備查詢並讀取 `Trading` 與 `Recent Trades`。

## What Changes
- 新增一份以 Markdown 交付的 `trae-agent` Code Wiki 文件，系統性整理整體架構、主要模組職責、關鍵類別與函式、依賴關係、執行與開發方式。
- 針對 `jev-ultrafast` 規劃一條可重現的 `Traderie` D2R 裝備查詢流程，支援輸入裝備名稱並取得 `Trading` 與 `Recent Trades` 兩類資訊。
- 為 Traderie 流程定義結構化輸出與獨立驗證，避免僅以代理選到 `DONE` 視為成功。
- 明確將 Notion 連結視為參考背景；本次最小交付以 Markdown 文件與本地可驗證流程為主，不包含自動回寫 Notion。

## Impact
- Affected specs: 文件產出、倉庫知識整理、瀏覽器代理場景擴展、結果驗證
- Affected code: `README.md`、`jev_ultrafast/agent.py`、`jev_ultrafast/browser.py`、`jev_ultrafast/model.py`、`jev_ultrafast/snapshot.js`、`examples/`、`tests/`

## ADDED Requirements
### Requirement: Trae Agent Code Wiki 文件
系統 SHALL 產出一份完整的 Markdown Code Wiki，用於說明 `https://github.com/bytedance/trae-agent` 倉庫。

#### Scenario: 文件涵蓋核心主題
- **WHEN** 產生 Code Wiki 文件
- **THEN** 文件必須包含專案定位、整體架構、主要模組職責、關鍵類別與函式、依賴與互動關係、執行方式、開發與測試方式

#### Scenario: 文件可追溯到原始碼
- **WHEN** 文件描述類別、函式、模組或執行流程
- **THEN** 應附上對應檔案路徑、模組名稱或可驗證的來源依據，使讀者能回到原始碼定位

#### Scenario: 文件結構可閱讀
- **WHEN** 新讀者閱讀 Code Wiki
- **THEN** 應能先理解高階架構，再進入模組、類別、函式、依賴與運行細節，而不需要自行重新拼湊倉庫結構

### Requirement: Traderie 裝備查詢流程
系統 SHALL 能以 `jev-ultrafast` 為基礎，從 `Traderie` 的 D2R 站點查詢指定裝備，並取得 `Trading` 與 `Recent Trades` 內容。

#### Scenario: 成功查到指定裝備
- **WHEN** 使用者提供一個 D2R 裝備名稱
- **THEN** 代理應進入對應的商品或交易頁面，並定位到與該裝備相關的內容

#### Scenario: 成功讀取兩類交易資訊
- **WHEN** 代理已到達目標裝備頁面
- **THEN** 系統必須能讀取目前掛單中的 `Trading` 資訊與歷史成交的 `Recent Trades` 資訊

#### Scenario: 查無結果或頁面受阻
- **WHEN** 指定裝備沒有結果、頁面互動失敗、或站點狀態不足以完成查詢
- **THEN** 系統必須回傳明確的失敗原因與停留證據，而不是回傳模糊成功

### Requirement: 結構化結果輸出
系統 SHALL 將 Traderie 查詢結果整理為可供人類閱讀與程式消費的結構化輸出。

#### Scenario: 查詢成功
- **WHEN** 已取得目標裝備的 `Trading` 與 `Recent Trades`
- **THEN** 輸出至少包含裝備名稱、目標頁面 URL、`Trading` 摘要、`Recent Trades` 摘要、觀測時間或證據片段

#### Scenario: 查詢失敗
- **WHEN** 查詢未完成
- **THEN** 輸出至少包含失敗階段、最後觀測到的頁面狀態、以及可重現問題的上下文

### Requirement: 獨立結果驗證
系統 SHALL 在代理流程完成後，獨立驗證是否真的到達指定裝備頁面且同時取得 `Trading` 與 `Recent Trades`。

#### Scenario: 驗證成功
- **WHEN** 代理宣告任務完成
- **THEN** 驗證邏輯必須確認頁面內容對應指定裝備，且兩類交易資訊都已被觀測與提取

#### Scenario: 驗證失敗
- **WHEN** 代理提早結束、頁面不一致、或只有部分資訊可見
- **THEN** 系統必須視為失敗並保留追蹤資訊，而不是接受 `DONE`

## MODIFIED Requirements
### Requirement: 站點無關的動作空間原則
系統 SHALL 繼續遵守 `jev-ultrafast` 既有的動作空間約束：以觀測到的元素與支援操作驅動執行，不依賴站點專屬腳本、硬編碼 selector、或模型輸出可執行程式碼。

#### Scenario: Traderie 場景擴展
- **WHEN** 為 Traderie 新增查詢能力
- **THEN** 實作必須優先透過既有的快照、動作空間、文字生成與驗證機制擴展，而不是引入站點專屬的捷徑或破壞通用性的特殊邏輯

#### Scenario: 需要輸入裝備名稱
- **WHEN** 流程需要輸入查詢關鍵字
- **THEN** 唯一允許的任務特定輸入應是使用者提供的裝備名稱與必要的目標敘述，不得預埋站點專屬答案

## REMOVED Requirements
- 無
