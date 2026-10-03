# future/（未來功能，目前不使用）

這個資料夾放的是「以後可能再做」的舊功能。它們目前**沒有人維護、沒有測試、也不會被打包進程式**。
以後想重新啟用時，檔案裡的 import（引用其他程式的寫法）可能需要先修正。

## 檔案說明

### analysis/
- `analysis.py`：把掛單與成交資料篩選、統計，整理成市場分析結果。
- `report.py`：把分析結果寫成繁體中文的市場行情報告。
- `no_llm.py`：不使用 AI 模型、直接用規則分析資料的命令列入口。
- `product_search.py`：用裝備名稱找到商品頁（先試直接網址，再用搜尋結果挑最像的）。

### scripts/
- `capture_traderie.py`：把網站頁面內容擷取存成檔案。
- `analyze_market.py`：對已存檔的資料跑市場分析。
- `render_traderie_demo.py`：把分析結果畫成示範畫面。

### tests/
- 上面這些功能原本的測試：分析、分析腳本、擷取腳本、缺值報告、無模型入口。

## 第二輪搬進來的檔案
- `analysis/parsing_extra.py`：解析網頁 HTML 的程式和「幾小時前」時間範圍的程式。目前流程只讀網頁文字，用不到。

## 第五輪搬進來的檔案
- `scripts/run.py`（原本的 `examples/run.py`）：通用的 Agent 執行範例，可指定任意網址和目標。
- `scripts/export_traderie_session.py`：把你自己 Chrome 裡的 Traderie 登入資料寫進 `.env`，只有 `JEV_CHROME=existing` 模式才用得到。連同裡面的 `upsert_dotenv`。
- `tests/test_export_traderie_session.py`：上面這支腳本的測試。要啟用時，先把腳本搬回 `scripts/`，測試才找得到它。
