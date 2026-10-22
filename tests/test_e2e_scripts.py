"""Offline tests of the pure parts of the Chrome end-to-end scripts (`scripts/extension_e2e.py`, `scan_e2e.py`,
`ocr_e2e.py`, `demo_e2e.py`, `stub_backend.py`).

The real drivers need Windows Chrome, the extension and (for OCR) a model download, so they only run under
`uv run --group e2e python scripts/<name>.py`. Their `verdict` functions are pure: they turn an already-collected
report into one Traditional Chinese message per failed section assertion. These tests build report dicts in the shape
`drive()` records (see `scan_e2e.drive` and `artifacts/ocr-e2e/report.json`) and flip one fact at a time. Every case
must fail the moment the check it covers is broken, so the assertions name the broken record, count or flag — not the
whole sentence.

The stub-chooser section covers the harness's zero-Jev mode (`--stub-chooser`): it drives the injected chooser through
services/jevsvc's own route table, so a broken injection or an answer of the wrong shape fails here, offline.
"""

import re
from datetime import datetime, timezone

import pytest

from jev_ultrafast.traderie.site import build_goal, phase_plan
from jevsvc import invites
from jevsvc.store import MemoryStore
from scripts import (
    demo_e2e,
    extension_batch,
    extension_e2e,
    ocr_e2e,
    probe_blocking,
    probe_stats,
    scan_e2e,
    stub_backend,
)

# --- extension_e2e.parse_sample ---------------------------------------------------------------------------


def test_parse_sample_treats_no_answer_and_non_json_as_a_failed_sample():
    assert extension_e2e.parse_sample(None) is None
    assert extension_e2e.parse_sample("") is None
    assert extension_e2e.parse_sample("側邊欄沒有回應") is None
    assert extension_e2e.parse_sample('{"view": "running", "rows": [1, 2]}') == {"view": "running", "rows": [1, 2]}


# --- extension_e2e stub chooser (the zero-Jev run) ----------------------------------------------------------

SECRET = "s" * 40
NOW = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
PRODUCT = "https://traderie.com/diablo2resurrected/product/harlequin-crest"


def click(ident: str, label: str) -> dict:
    """One action of an observation, in the shape services/jevsvc/app.py:clean_action leaves behind."""
    return {"kind": "click", "id": ident, "label": label, "node": 1}


def scroll(ident: str) -> dict:
    """The page-level scroll control snapshot.js adds when there is more page below the viewport."""
    return {"kind": "scroll", "id": ident, "label": "Scroll to bottom of page", "delta": 600}


def stub_page(url=PRODUCT, actions=()):
    """The page a chooser is handed: choose_step cleans it first, so these are the only keys a chooser sees."""
    return {"url": url, "title": "Harlequin Crest", "text": "Trading For", "actions": list(actions)}


def phase_goals(load_more=2):
    """The two goals the backend builds, exactly as choose_step hands them to a chooser."""
    return phase_plan(build_goal("Harlequin Crest", load_more))[0]


def stub_chooser(lines=None) -> stub_backend.StubChooser:
    """A StubChooser that appends its log lines to `lines` (the run prints them; here they are read back)."""
    return stub_backend.StubChooser(log=(lines if lines is not None else []).append)


def test_stub_phase_reads_the_phase_out_of_the_goal_the_backend_builds():
    assert [stub_backend.stub_phase(goal) for goal in phase_goals()] == ["trading", "recent_trades"]
    assert stub_backend.stub_phase("no phase line") == "trading"  # the only safe guess; the log shows its page


def test_goal_batches_reads_the_requested_presses_and_zero_when_none_are_asked_for():
    assert [stub_backend.goal_batches(goal) for goal in phase_goals(3)] == [3, 3]
    assert [stub_backend.goal_batches(goal) for goal in phase_goals(0)] == [0, 0]


def test_stub_decision_has_the_shape_choose_step_passes_on():
    # The keys tests/test_services.py's stub chooser returns, plus latency_ms (agent.history records it).
    answer = stub_backend.stub_decision("DONE", "DONE", {"DONE": 1.0})
    assert set(answer) == {
        "choice",
        "operation",
        "target",
        "probabilities",
        "operation_probabilities",
        "target_probabilities",
        "usage",
        "reasked",
        "model_calls",
        "latency_ms",
    }
    assert (answer["choice"], answer["operation"], answer["model_calls"]) == ("DONE", "DONE", 1)


def test_stub_chooser_scrolls_once_when_the_goal_asks_for_batches_then_leaves_the_presses_to_the_rule():
    chooser = stub_chooser()
    page = stub_page(actions=[scroll("scroll_bottom"), click("e33", "Recent Trades")])
    answer = chooser(page, phase_goals(2)[0], [])
    assert (answer["operation"], answer["choice"]) == ("SCROLL_BOTTOM", "scroll_bottom")
    # After that one scroll the phase already moved once, so a second question in phase A is the goal's own
    # "no Load More button is visible" case: DONE.
    done = chooser(page, phase_goals(2)[0], [{"action": "Scroll to bottom of page", "kind": "scroll"}])
    assert (done["operation"], done["choice"]) == ("DONE", "DONE")


def test_stub_chooser_answers_done_at_once_without_batches_or_without_a_scroll_control():
    # load_more 0: the goal says to choose DONE as soon as the view is open, and nothing is clicked or scrolled.
    chooser = stub_chooser()
    assert chooser(stub_page(actions=[click("e13", "Load More")]), phase_goals(0)[0], [])["choice"] == "DONE"
    # Batches wanted but the page offers no scroll control (already at the bottom): DONE rather than a stale choice.
    assert chooser(stub_page(actions=[click("e13", "Load More")]), phase_goals(2)[0], [])["choice"] == "DONE"


def test_stub_chooser_clicks_the_pages_own_recent_trades_tab_then_dones_once_that_view_is_open():
    chooser = stub_chooser()
    page = stub_page(actions=[click("e12", "Trading"), click("e33", "Recent Trades")])
    answer = chooser(page, phase_goals()[1], [])
    assert (answer["operation"], answer["choice"], answer["probabilities"]) == ("CLICK", "e33", {"e33": 1.0})
    opened = stub_page(url=f"{PRODUCT}/recent")
    assert chooser(opened, phase_goals()[1], [])["choice"] == "DONE"


def test_stub_chooser_ignores_a_recent_trades_label_that_is_not_a_click():
    chooser = stub_chooser()
    row = {"kind": "scroll", "id": "scroll_down", "label": "Recent Trades"}
    assert chooser(stub_page(actions=[row]), phase_goals()[1], [])["choice"] == "DONE"


def test_stub_chooser_logs_a_timestamped_line_per_request_naming_what_it_saw():
    lines = []
    chooser = stub_chooser(lines)
    chooser(stub_page(actions=[click("e13", "Log in to Load More")]), phase_goals()[0], [])
    chooser(stub_page(), phase_goals()[1], [])
    assert (chooser.requests, len(lines)) == (2, 2)
    assert re.match(r"^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] stub #1 phase=trading ", lines[0])
    assert "phase=recent_trades" in lines[1] and "-> DONE DONE" in lines[1]
    # The Load More button is named even though the stub never presses it: a short list is then explained by the log.
    assert "load_more='Log in to Load More'" in lines[0] and "load_more='none'" in lines[1]


def test_the_stub_route_answers_a_whole_query_through_the_backends_own_pipeline(monkeypatch):
    """No TypeSafe key anywhere: run start and both steps answer through services/jevsvc's own route table."""
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    log = []
    store = MemoryStore()
    routes = stub_backend.stub_routes(stub_chooser(log))
    status, started = routes["/api/run/start"](
        {"invite": invites.add(store, "stub"), "item_name": "Harlequin Crest", "load_more": 2},
        "1.1.1.1",
        store,
        SECRET,
        NOW,
    )
    assert status == 200, started
    page = stub_page(actions=[scroll("scroll_bottom"), click("e33", "Recent Trades")])
    ask = {"run_token": started["run_token"], "history": [], "page": page}
    trading = routes["/api/choose"]({**ask, "phase": "trading"}, "1.1.1.1", store, SECRET, NOW)
    recent = routes["/api/choose"]({**ask, "phase": "recent_trades"}, "1.1.1.1", store, SECRET, NOW)
    opened = routes["/api/choose"](
        {**ask, "phase": "recent_trades", "page": stub_page(url=f"{PRODUCT}/recent")}, "1.1.1.1", store, SECRET, NOW
    )
    # The three answers a --stub-chooser run is made of, in order, straight out of the backend's route table.
    assert [(status, body["operation"], body["choice"]) for status, body in (trading, recent, opened)] == [
        (200, "SCROLL_BOTTOM", "scroll_bottom"),
        (200, "CLICK", "e33"),
        (200, "DONE", "DONE"),
    ]
    assert "request" not in trading[1] and "raw_answers" not in trading[1]  # what choose_step strips from a decision
    assert len(log) == 3


# --- the shape every verdict test asserts on ---------------------------------------------------------------


def only_failure(failures: list[str]) -> str:
    """The one failure a verdict reported for a single flipped fact.

    Asserting the length here is what makes each parametrized case precise: two failures would mean the flip broke an
    unrelated check as well, and the message shows the extra ones.
    """
    assert len(failures) == 1, failures
    return failures[0]


# --- scan_e2e.verdict -------------------------------------------------------------------------------------


def scan_click(**overrides) -> dict:
    """What one search button did with the stub in place: the scan list gave way to a query that really started (the
    running screen showed, the stub saw a query window being opened) and that ended on the problem the refused window
    gives. Every field a case does not mention is the fact of a healthy click."""
    return {
        "outcome": "clicked", "mode": "name", "view": "problem", "item": "", "summary": "", "ticks": 0,
        "statsBase": "", "statsBaseFrom": "", "statsBaseMarked": False, "baseOptions": 250, "banner": True,
        "windows_before": 0, "windows": 1, "starts_before": 0, "starts": 1, "ran": True, **overrides,
    }


def scan_report() -> dict:
    """A complete scan report: the four simulated records, every search button started its query. verdict() -> []."""
    expects = ["Alma Negra", "Grand Charm", "Harlequin Crest", "Stormshield"]
    # `records` is what the panel's STATE probe collects from `#scan-list li`: one string per record, the concatenated
    # textContent of the name line, the `HH:MM:SS · 類型 · 詞綴` line and the button labels (scripts/scan_e2e.py).
    records = [f"{name} 00:00:0{i} · 暗金 · 力量＋20 精準搜尋 模糊搜尋" for i, name in enumerate(expects)]
    return {
        "expects": expects,
        "base_name": "Grand Charm",
        "record_count": len(expects),
        "records": records,
        "names": list(expects),
        "csv_enabled": True,
        "visibility": "hidden",
        "status": "遊戲視窗蓋住了這個面板，掃描會變慢。 掃描中：已記錄 4 件，待辨識 0 件",
        # Four name queries (each asks the backend once), then two affix queries (the affix search never asks it).
        "exact_clicks": [
            scan_click(
                name=name, item=name, shown_field=name, summary=f"查詢：{name}",
                windows_before=i, windows=i + 1, starts_before=i, starts=i + 1,
            )
            for i, name in enumerate(expects)
        ],
        "fuzzy_item": scan_click(
            mode="stats", statsBase="Sacred Rondache", statsBaseFrom="ocr", statsBaseMarked=True,
            windows_before=4, windows=5, starts_before=4, starts=5,
        ),
        "fuzzy_base": scan_click(
            mode="stats", statsBase="Grand Charm", windows_before=5, windows=6, starts_before=5, starts=6,
        ),
        # Three of the four reads (an item with its type line under it) are not sure: they wait on the list with both
        # searches disabled, the script picks the right name on each, and every row ends up named and searchable.
        "unsure_before": [
            {
                "name": "",
                "unsure": True,
                "options": [name, "Sacred Rondache", "Rondache"],
                "searchesDisabled": [True, True],
            }
            for name in ("Alma Negra", "Harlequin Crest", "Stormshield")
        ],
        "unsure_picks": [
            {"name": name, "outcome": "picked"} for name in ("Alma Negra", "Harlequin Crest", "Stormshield")
        ],
        "unsure_after": [
            {"name": name, "unsure": False, "options": [], "searchesDisabled": [False, False]} for name in expects
        ],
        "banner": "",
        "scan_views": [["welcome", ""], ["scan", ""]],
        "views": [["scan", ""]] + [["running", ""]] * 6 + [["problem", "stats"]],
        "clear": {"before": 4, "after": 0, "csv": False, "status": "已停止，待辨識 0 件"},
        "listing": scan_listing("Alma Negra"),
    }


def scan_listing(name: str) -> dict:
    """What 「TR交易」 on the record `name` showed: the listing screen, prefilled, 上架 off for want of a price."""
    return {
        "name": name, "outcome": "clicked", "line2": "00:00:00 · 暗金 · 力量＋20", "view": "listing",
        "item": f"{name} · 暗金", "affixes": 1, "marked": 1, "postDisabled": True,
        "why": "請選擇想換的符文和數量，或勾「接受出價」", "status": "", "createRequests": 0,
        "back_view": "scan", "records_before": 4, "records_after": 4, "runeOptions": 35, "selectOptions": 40,
    }


def test_scan_verdict_reports_a_listing_screen_that_did_not_open_prefilled_or_that_posted():
    report = scan_report()
    report["listing"]["marked"] = 0
    report["listing"]["postDisabled"] = False
    assert len(scan_e2e.verdict(report)) == 2
    report = scan_report()
    report["listing"]["createRequests"] = 1
    report["listing"]["back_view"] = "listing"
    messages = scan_e2e.verdict(report)
    assert len(messages) == 2
    assert "返回" in messages[0] and "listings/create" in messages[1]
    report = scan_report()
    report["listing"] = None
    assert scan_e2e.verdict(report) == ["「TR交易」沒有打開上架畫面：None"]


def test_scan_verdict_accepts_a_report_that_matches_every_section_6_assertion():
    assert scan_e2e.verdict(scan_report()) == []


def test_scan_verdict_accepts_a_run_where_every_read_was_sure_and_no_row_was_unsure():
    report = scan_report()
    report["unsure_before"] = []
    report["unsure_picks"] = []
    assert scan_e2e.verdict(report) == []

def test_scan_verdict_accepts_failures_page_report():
    report = {
        "sim_page_type": "failures",
        "record_count": 6,
        "records": [
            "懺悔者（The Redeemer） · 暗金 · 聖騎士技能",
            "戒指（Ring） · 底材 · 施法速度",
            "戒指（Ring） · 底材 · 所有抗性",
            "權冠（Diadem） · 底材 · 防禦",
            "猛狼頭盔（Alpha Helm） · 底材 · 防禦",
            "戒指（Ring） · 底材 · 冰寒抗性",
        ],
        "csv_enabled": True,
        "visibility": "hidden",
        "status": "蓋住了這個面板 掃描中：已記錄 6 件，待辨識 0 件",
        "banner": False,
        "scan_views": [["welcome", ""], ["scan", ""]],
        "views": [["scan", ""]] + [["running", ""]] * 5 + [["problem", "stats"]],
        "clear": {"before": 6, "after": 0, "csv": False},
        "listing": {**scan_listing("The Redeemer"), "records_before": 6, "records_after": 6},
        "exact_clicks": [
            scan_click(name=name, item=field, shown_field=field, summary=f"查詢：{field}",
                       windows_before=i, windows=i + 1, starts_before=i, starts=i + 1)
            for i, (name, field) in enumerate(
                [("Ring", "戒指"), ("Alpha Helm", "猛狼頭盔"), ("Diadem", "權冠"), ("The Redeemer", "懺悔者")]
            )
        ],
        "fuzzy_base": scan_click(mode="stats", windows_before=4, windows=5, starts_before=4, starts=5),
    }
    assert scan_e2e.verdict(report) == []


def _count_wrong(report):
    report["record_count"] = 3


def _name_set_wrong(report):
    report["names"][2] = "Something Else"


def _duplicate_name(report):
    report["expects"][1] = "Alma Negra"
    report["names"][1] = "Alma Negra"


def _notice_missing_though_hidden(report):
    report["status"] = "掃描中：已記錄 4 件，待辨識 0 件"


def _notice_shown_though_visible(report):
    report["visibility"] = "visible"


def _csv_disabled(report):
    report["csv_enabled"] = False


def _exact_outcome_wrong(report):
    report["exact_clicks"][1]["outcome"] = "no-button"


def _exact_mode_wrong(report):
    report["exact_clicks"][1]["mode"] = "stats"


def _exact_view_wrong(report):
    report["exact_clicks"][1]["view"] = "running"


def _exact_item_wrong(report):
    report["exact_clicks"][1]["item"] = "Wrong Item"


def _fuzzy_item_outcome_wrong(report):
    report["fuzzy_item"]["outcome"] = "no-record"


def _fuzzy_item_mode_wrong(report):
    report["fuzzy_item"]["mode"] = "name"


def _fuzzy_item_view_wrong(report):
    report["fuzzy_item"]["view"] = "running"


def _fuzzy_item_no_tick(report):
    report["fuzzy_item"]["ticks"] = 1


def _exact_never_started(report):
    report["exact_clicks"][2].update(windows=report["exact_clicks"][2]["windows_before"], ran=False)


def _exact_asked_the_backend_twice(report):
    report["exact_clicks"][0]["starts"] = 2


def _fuzzy_item_never_asked_the_backend(report):
    report["fuzzy_item"]["starts"] = report["fuzzy_item"]["starts_before"]


def _fuzzy_base_never_started(report):
    report["fuzzy_base"].update(windows=report["fuzzy_base"]["windows_before"], ran=False)


def _searches_never_ran(report):
    report["views"] = [["scan", ""], ["problem", "stats"]]


def _fuzzy_item_no_base(report):
    report["fuzzy_item"]["statsBase"] = ""


def _fuzzy_item_base_not_marked(report):
    report["fuzzy_item"]["statsBaseFrom"] = ""


def _fuzzy_item_base_mark_missing(report):
    report["fuzzy_item"]["statsBaseMarked"] = False


def _clear_never_pressed(report):
    report["clear"] = {"before": 0, "after": 0, "csv": False, "status": ""}


def _clear_left_records(report):
    report["clear"] = {"before": 4, "after": 1, "csv": True, "status": "待辨識 0 件"}


def _fuzzy_item_no_base_options(report):
    report["fuzzy_item"]["baseOptions"] = 0


def _fuzzy_item_missing(report):
    del report["fuzzy_item"]


def _fuzzy_base_mode_wrong(report):
    report["fuzzy_base"]["mode"] = "name"


def _fuzzy_base_not_filled(report):
    report["fuzzy_base"]["statsBase"] = ""


def _banner_shown(report):
    report["banner"] = "查詢橫幅"


def _view_ran_a_query(report):
    report["scan_views"].append(["running", "stats"])


def _row_unsure_after_though_none_was_before(report):
    report["unsure_before"] = []
    report["unsure_picks"] = []
    report["unsure_after"][0].update(name="", unsure=True)


def _unsure_row_could_search(report):
    report["unsure_before"][1]["searchesDisabled"] = [True, False]


def _unsure_option_not_found(report):
    report["unsure_picks"][0]["outcome"] = "no-option"


def _row_still_unsure_after_the_pick(report):
    report["unsure_after"][2].update(name="", unsure=True)


def _named_row_cannot_search(report):
    report["unsure_after"][1]["searchesDisabled"] = [True, False]


@pytest.mark.parametrize(
    ("mutate", "token"),
    [
        pytest.param(_count_wrong, "3", id="record-count"),
        pytest.param(_name_set_wrong, "Something Else", id="name-set"),
        pytest.param(_duplicate_name, "Alma Negra", id="duplicate-name"),
        pytest.param(_csv_disabled, "scan-csv", id="csv-disabled"),
        pytest.param(_notice_missing_though_hidden, "提醒和頁面可見狀態不一致", id="notice-missing-though-hidden"),
        pytest.param(_notice_shown_though_visible, "提醒和頁面可見狀態不一致", id="notice-shown-though-visible"),
        pytest.param(_exact_outcome_wrong, "Grand Charm", id="exact-click-outcome"),
        pytest.param(_exact_mode_wrong, "Grand Charm", id="exact-click-mode"),
        pytest.param(_exact_view_wrong, "Grand Charm", id="exact-click-view"),
        pytest.param(_exact_item_wrong, "Grand Charm", id="exact-click-item"),
        pytest.param(_fuzzy_item_outcome_wrong, "no-record", id="fuzzy-item-outcome"),
        pytest.param(_fuzzy_item_mode_wrong, "'mode': 'name'", id="fuzzy-item-mode"),
        pytest.param(_fuzzy_item_view_wrong, "'view': 'running'", id="fuzzy-item-view"),
        pytest.param(_fuzzy_item_no_tick, "'ticks': 1", id="fuzzy-item-no-tick"),
        pytest.param(_exact_never_started, "沒有真的開始查詢", id="exact-click-never-started"),
        pytest.param(_exact_asked_the_backend_twice, "沒有真的開始查詢", id="exact-click-asked-the-backend-twice"),
        pytest.param(_fuzzy_item_never_asked_the_backend, "沒有真的開始查詢", id="fuzzy-item-asked-the-backend"),
        pytest.param(_fuzzy_base_never_started, "沒有真的開始查詢", id="fuzzy-base-never-started"),
        pytest.param(_searches_never_ran, "只看到 0 次 running", id="searches-never-ran"),
        pytest.param(_fuzzy_item_no_base, "應預填同一輪讀到的底材候選", id="fuzzy-item-no-base"),
        pytest.param(_fuzzy_item_base_not_marked, "標記為來自擷取", id="fuzzy-item-base-not-marked"),
        pytest.param(_fuzzy_item_base_mark_missing, "看不出是擷取來的", id="fuzzy-item-base-mark-missing"),
        pytest.param(_fuzzy_item_no_base_options, "沒有出貨清單的建議選項", id="fuzzy-item-no-base-options"),
        pytest.param(_fuzzy_item_missing, "None", id="fuzzy-item-missing"),
        pytest.param(_clear_never_pressed, "沒有在有紀錄時按下去", id="clear-never-pressed"),
        pytest.param(_clear_left_records, "仍有紀錄", id="clear-left-records"),
        pytest.param(_fuzzy_base_mode_wrong, "'mode': 'name'", id="fuzzy-base-mode"),
        pytest.param(_fuzzy_base_not_filled, "stats-base", id="fuzzy-base-not-filled"),
        pytest.param(_banner_shown, "橫幅", id="banner-shown"),
        pytest.param(_view_ran_a_query, "running", id="view-ran-a-query"),
        pytest.param(_row_unsure_after_though_none_was_before, "仍有沒決定的紀錄", id="row-unsure-none-before"),
        pytest.param(_unsure_row_could_search, "搜尋按鈕都應該停用", id="unsure-row-could-search"),
        pytest.param(_unsure_option_not_found, "找不到要點的名稱", id="unsure-option-not-found"),
        pytest.param(_row_still_unsure_after_the_pick, "仍有沒決定的紀錄", id="row-still-unsure-after-the-pick"),
        pytest.param(_named_row_cannot_search, "仍是停用的", id="named-row-cannot-search"),
    ],
)
def test_scan_verdict_reports_exactly_the_single_broken_assertion(mutate, token):
    report = scan_report()
    mutate(report)
    assert token in only_failure(scan_e2e.verdict(report))


def shot(**overrides) -> dict:
    """One `--shots` screenshot record: what the probe measured on that screen at that width."""
    return {
        "view": "scan", "width": 400, "file": "artifacts/scan-e2e/shots/scan-400.png",
        "overflow": False, "rows": 4, "maxLines": 1, "wide": 396, "headings": "H1,H2",
        **overrides,
    }


def test_shot_layout_checks_pass_for_a_healthy_set_of_screenshots():
    report = scan_report()
    report["shots"] = [
        shot(), shot(width=320, maxLines=2, wide=316),
        shot(view="ready", rows=0, wide=None, headings="H1,H2"),
        shot(view="listing", rows=0, headings="H1,H2"),
        shot(view="settings", rows=0, wide=None, headings="H1,H2,H3,H3,H3,H3,H3,H3"),
    ]
    assert scan_e2e.verdict(report) == []


def test_shot_layout_checks_report_the_broken_one():
    report = scan_report()
    report["shots"] = [shot()]
    assert scan_e2e.verdict(scan_report()) == []  # no shots, no layout claims
    for mutated, token in [
        ({"overflow": True}, "左右捲動"),
        ({"maxLines": 2}, "沒有排成一行"),
        ({"width": 320, "maxLines": 3}, "換行超過兩行"),
        ({"wide": 300}, "沒有填滿畫面"),
        ({"headings": "H2"}, "第一個標題不是 h1"),
        ({"headings": "H1,H3"}, "跳了層級"),
    ]:
        broken = scan_report()
        broken["shots"] = [shot(**mutated)]
        messages = scan_e2e.verdict(broken)
        assert len(messages) == 1 and token in messages[0], mutated


# --- ocr_e2e.verdict --------------------------------------------------------------------------------------


def ocr_report() -> dict:
    """The recorded shape of artifacts/ocr-e2e/report.json: every group present and passing."""
    return {
        "download": {
            "no_consent_element": True,
            "no_download_ui": True,
            "requests_started_by_themselves": True,
            "only_fixed_urls": True,
            "second_run_no_download": True,
            "after_reload_no_download": True,
            "blocked_is_clear": True,
            "blocked_not_retried": True,
        },
        "accuracy": {
            "scored": 18, "top1": 17, "top3": 18, "screenshots_top3": 18, "phone_top3": 0,
            "asked": 12, "auto_right": 10, "auto_wrong": 0,
        },
        "accuracy_holdout": {
            "scored": 30, "top1": 22, "top3": 29, "screenshots_top3": 17, "phone_top3": 12,
            "asked": 21, "auto_right": 9, "auto_wrong": 0,
        },
        "auto": {
            "reads_by_itself_with_model": True,
            "did_not_start_a_query": True,
            "no_model_no_auto_read": True,
            "no_model_nothing_downloaded": True,
        },
        "affix": {
            "label_ok": True,
            "rows_present": True,
            "all_mapped_on": True,
            "values_filled": True,
            "values_marked": True,
            "no_query_started": True,
            "start_gate_after_capture": {"disabled": False, "whyVisible": False},
            "start_gate_after_clearing": {"disabled": True, "whyVisible": True},
            "start_enabled_after_value": {"disabled": False, "whyVisible": False},
            "value_learned": {"stored": True, "refilled": ocr_e2e.VALUE_TYPED, "marked_learned": True},
        },
        "warm": {"reads": [], "gap_median_ms": 120, "gap_max_ms": 180, "first_gap_ms": 150, "shown_median_s": 1.0},
    }


ACCURACY_FLOORS = {"scored": 18, "top1": 16, "top3": 17, "screenshots_top3": 17, "phone_top3": 0}
HOLDOUT_FLOORS = {"scored": 30, "top1": 22, "top3": 26, "screenshots_top3": 16, "phone_top3": 10}


def ocr_failures(report) -> list[str]:
    """What `ocr_e2e.verdict` reports for `report` against the two committed floor tables."""
    return ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)


def test_ocr_verdict_accepts_a_report_that_meets_every_floor_and_flag():
    assert ocr_failures(ocr_report()) == []


@pytest.mark.parametrize("block", ["accuracy", "accuracy_holdout"])
def test_ocr_verdict_rejects_a_name_the_panel_filled_in_by_itself_that_was_wrong(block):
    report = ocr_report()
    report[block]["auto_wrong"] = 1
    failures = ocr_failures(report)
    assert len(failures) == 1, failures
    assert "自己填了錯的名稱" in failures[0]


def test_ocr_verdict_accepts_a_report_from_before_the_panel_asked_anything():
    report = ocr_report()
    for block in ("accuracy", "accuracy_holdout"):
        for key in ("asked", "auto_right", "auto_wrong"):
            del report[block][key]
    assert ocr_failures(report) == []


def reader_state(**over) -> dict:
    """The part of ocr_e2e.STATE the candidate order reads: status, the buttons, and what the panel exposes."""
    return {
        "status": "已辨識，並填入裝備名稱「蜘蛛之網（Arachnid Mesh）」。請確認後自己按「開始查詢」。",
        "unsure": False,
        "firstKind": "item",
        "firstName": "Arachnid Mesh",
        "candidates": [
            {"kind": "item", "name": "Arachnid Mesh"},
            {"kind": "base", "name": "Spiderweb Sash"},
        ],
        **over,
    }


def test_a_sure_read_lists_the_filled_name_first_and_then_the_other_buttons():
    assert ocr_e2e.candidate_order(reader_state()) == ["item:Arachnid Mesh", "base:Spiderweb Sash"]


def test_an_unsure_read_lists_every_decision_button_in_order_and_never_counts_the_way_out():
    state = reader_state(
        status="不確定是哪一件，請點選一個：",
        unsure=True,
        candidates=[
            {"kind": "item", "name": "Opalvein"},
            {"kind": "base", "name": "Ring"},
            {"kind": "", "name": ""},  # 都不是，我自己輸入
        ],
    )
    assert ocr_e2e.candidate_order(state) == ["item:Opalvein", "base:Ring"]


def test_an_unsure_read_scores_the_matchers_three_and_keeps_the_extra_possible_names_apart():
    state = reader_state(
        status="不確定是哪一件，請點選一個：",
        unsure=True,
        candidates=[{"kind": "item", "name": f"Name {i}"} for i in range(5)] + [{"kind": "", "name": ""}],
    )
    assert ocr_e2e.candidate_order(state) == ["item:Name 0", "item:Name 1", "item:Name 2"]
    assert ocr_e2e.possible_names(state) == [f"item:Name {i}" for i in range(5)]


def test_accuracy_metrics_count_an_asked_read_whose_answer_is_only_among_the_extra_possible_names():
    def row(ok, ok5):
        return {"top1": False, "ok": ok, "ok5": ok5, "unsure": True, "skip": False, "phone": False, "seconds": 1.0}

    metrics = ocr_e2e.accuracy_metrics([row(True, True), row(False, True), row(False, False)])
    assert (metrics["asked"], metrics["asked_top3"], metrics["asked_top5"]) == (3, 1, 2)


def test_ocr_verdict_fails_a_learning_step_that_did_not_hold():
    report = ocr_report()
    report["learning"] = {"file": "image-46.png", "first_asks": True, "third_fills_by_itself": False}
    failures = ocr_e2e.verdict(report)
    assert len(failures) == 1 and "third_fills_by_itself" in failures[0]


def test_a_read_that_found_nothing_lists_no_candidates():
    state = reader_state(status="認不出裝備名稱，請手動輸入英文名稱。", candidates=[], firstKind="", firstName="")
    assert ocr_e2e.candidate_order(state) == []


def test_accuracy_metrics_count_what_the_panel_asked_and_what_it_filled_in_by_itself():
    def row(top1, unsure=False, skip=False):
        return {"top1": top1, "ok": top1, "unsure": unsure, "skip": skip, "phone": False, "seconds": 1.0}

    metrics = ocr_e2e.accuracy_metrics(
        [row(True), row(False), row(False, unsure=True), row(True, unsure=True), row(False, skip=True)]
    )
    assert (metrics["scored"], metrics["asked"], metrics["auto_right"], metrics["auto_wrong"]) == (4, 2, 1, 1)


def test_ocr_verdict_skips_the_floors_when_no_accepted_floor_is_given():
    # No floors: accuracy is not compared; the holdout block exists but its floor is not invented yet.
    assert ocr_e2e.verdict(ocr_report()) == []


@pytest.mark.parametrize("key", ocr_e2e.ACCURACY_KEYS)
def test_ocr_verdict_rejects_accuracy_below_its_floor(key):
    report = ocr_report()
    floors = dict(ACCURACY_FLOORS)
    floors[key] = report["accuracy"][key] + 1
    failures = ocr_e2e.verdict(report, floors=floors, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert key in failures[0] and str(floors[key]) in failures[0]


def test_ocr_verdict_does_not_compare_accuracy_against_floors_of_a_different_size():
    report = ocr_report()
    floors = dict(ACCURACY_FLOORS, scored=10)
    assert ocr_e2e.verdict(report, floors=floors, holdout=HOLDOUT_FLOORS) == []


@pytest.mark.parametrize("key", ocr_e2e.ACCURACY_KEYS)
def test_ocr_verdict_rejects_holdout_accuracy_below_its_floor(key):
    report = ocr_report()
    holdout = dict(HOLDOUT_FLOORS)
    holdout[key] = report["accuracy_holdout"][key] + 1
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=holdout)
    assert len(failures) == 1, failures
    assert "保留組" in failures[0] and key in failures[0]


def test_ocr_verdict_accepts_the_first_holdout_run_with_no_floor():
    # holdout=None with the block present is the accepted first run: its numbers become the next floor.
    assert ocr_e2e.verdict(ocr_report(), floors=ACCURACY_FLOORS, holdout=None) == []


@pytest.mark.parametrize(
    "key",
    [
        "no_consent_element",
        "no_download_ui",
        "requests_started_by_themselves",
        "only_fixed_urls",
        "second_run_no_download",
        "after_reload_no_download",
        "blocked_is_clear",
        "blocked_not_retried",
    ],
)
def test_ocr_verdict_rejects_a_download_check_that_is_not_true(key):
    report = ocr_report()
    report["download"][key] = False
    assert key in only_failure(ocr_failures(report))


@pytest.mark.parametrize(
    "key",
    [
        "reads_by_itself_with_model",
        "did_not_start_a_query",
        "no_model_no_auto_read",
        "no_model_nothing_downloaded",
    ],
)
def test_ocr_verdict_rejects_an_auto_check_that_is_not_true(key):
    report = ocr_report()
    report["auto"][key] = False
    assert key in only_failure(ocr_failures(report))


@pytest.mark.parametrize(
    "key", ["label_ok", "rows_present", "all_mapped_on", "values_filled", "values_marked", "no_query_started"]
)
def test_ocr_verdict_rejects_an_affix_check_that_is_not_true(key):
    report = ocr_report()
    report["affix"][key] = False
    assert key in only_failure(ocr_failures(report))


@pytest.mark.parametrize("gate", [{"disabled": True, "whyVisible": False}, {"disabled": True, "whyVisible": True}])
def test_ocr_verdict_rejects_a_captured_value_that_did_not_open_the_start_gate(gate):
    report = ocr_report()
    report["affix"]["start_gate_after_capture"] = gate
    assert "start_gate_after_capture" in only_failure(ocr_failures(report))


@pytest.mark.parametrize("gate", [{"disabled": False, "whyVisible": True}, {"disabled": True, "whyVisible": False}])
def test_ocr_verdict_rejects_a_start_gate_that_stayed_open_with_every_box_empty(gate):
    report = ocr_report()
    report["affix"]["start_gate_after_clearing"] = gate
    assert "start_gate_after_clearing" in only_failure(ocr_failures(report))


def test_ocr_verdict_rejects_a_start_that_stayed_disabled_after_filling_a_value():
    report = ocr_report()
    report["affix"]["start_enabled_after_value"] = {"disabled": True, "whyVisible": True}
    assert "start_enabled_after_value" in only_failure(ocr_failures(report))


@pytest.mark.parametrize(
    "learned",
    [
        {"stored": False, "refilled": None, "marked_learned": False},
        {"stored": True, "refilled": "11", "marked_learned": False},
        {"stored": True, "refilled": ocr_e2e.VALUE_TYPED, "marked_learned": False},
    ],
)
def test_ocr_verdict_rejects_a_number_correction_that_was_not_remembered_or_not_filled_back(learned):
    report = ocr_report()
    report["affix"]["value_learned"] = learned
    assert "數值" in only_failure(ocr_failures(report))


def test_ocr_verdict_accepts_an_unmeasured_start_enabled_check():
    # A bool-only affix row has no number box, so start_enabled_after_value is never measured (None).
    report = ocr_report()
    report["affix"]["start_enabled_after_value"] = None
    assert ocr_failures(report) == []


def test_ocr_verdict_rejects_a_warm_read_whose_extra_wait_is_over_the_bound():
    report = ocr_report()
    report["warm"]["gap_max_ms"] = ocr_e2e.WARM_GAP_MAX_MS + 1
    assert "額外等待" in only_failure(ocr_failures(report))


def test_ocr_verdict_rejects_a_first_warm_read_far_slower_than_the_median():
    report = ocr_report()
    report["warm"]["first_gap_ms"] = report["warm"]["gap_median_ms"] + ocr_e2e.WARM_FIRST_EXTRA_MS + 1
    assert "暖機" in only_failure(ocr_failures(report))


def test_scan_and_ocr_verdicts_are_pure():
    report = scan_report()
    ocr = ocr_report()
    scan_e2e.verdict(report)
    ocr_failures(ocr)
    assert report == scan_report() and ocr == ocr_report()


# --- extension_batch.judge (the classifier of the runs that cost real quota) ---------------------------------

BATCH_PRODUCT = "https://www.traderie.com/diablo2resurrected/product/harlequin-crest"


def batch_case(**over):
    """One case as `scripts/data/e2e_cases.json` declares it, with the keys judge reads."""
    case = {"expect": "pass", "input": "Shako", "load_more": 0, "slug": "harlequin-crest", "layer": "table"}
    case.update(over)
    return case


def batch_result(**over):
    """One recorded result in the shape `run_case` leaves behind: the panel snapshot plus `urls`/`seconds`."""
    result = {
        "status": extension_batch.DONE,
        "pills": ["PASSED", "PASSED"],
        "rows": [3, 2],
        "urls": [BATCH_PRODUCT, f"{BATCH_PRODUCT}/recent"],
        "verification": "兩段資料都通過檢查",
        "meta": "trading 3 · recent 2",
        "lookup": "查詢方式：查表直接開啟",
        "quota": "已用 3/100",
        "locked": False,
        "idle": True,
        "seconds": 12.0,
    }
    result.update(over)
    return result


def batch_verdict(case, result, last_used: int | None = None) -> str:
    """Just the PASS/FAIL/GAP word of `extension_batch.judge`'s `(verdict, reason)` pair."""
    return extension_batch.judge(case, result, last_used)[0]


def test_batch_judge_passes_a_clean_paid_run():
    assert extension_batch.judge(batch_case(), batch_result(), None) == ("PASS", "")


def test_batch_judge_fails_a_timeout_before_anything_else():
    verdict, reason = extension_batch.judge(batch_case(), batch_result(timeout=True, status="卡住"), None)
    assert verdict == "FAIL" and "逾時" in reason


def test_batch_judge_calls_a_site_challenge_blocked():
    verdict, reason = extension_batch.judge(batch_case(), batch_result(status="網站阻擋：防護頁"), None)
    assert verdict == "BLOCKED" and reason == "網站阻擋：防護頁"


@pytest.mark.parametrize("expect,contains", [("error", "邀請碼無效"), ("not_found", "找不到這個裝備")])
def test_batch_judge_checks_the_expected_message_and_that_nothing_was_read(expect, contains):
    case = batch_case(expect=expect, contains=contains)
    assert batch_verdict(case, batch_result(status=contains, rows=[0, 0])) == "PASS"
    assert batch_verdict(case, batch_result(status=contains, rows=[1, 0])) == "FAIL"
    assert batch_verdict(case, batch_result(status="別的訊息", rows=[0, 0])) == "FAIL"


def test_batch_judge_wants_a_stopped_run_that_let_go_of_the_sidebar():
    case = batch_case(expect="stop")
    assert batch_verdict(case, batch_result(status="已停止")) == "PASS"
    assert batch_verdict(case, batch_result(status="已停止", locked=True)) == "FAIL"
    assert batch_verdict(case, batch_result(status=extension_batch.DONE)) == "FAIL"


def test_batch_judge_accepts_either_the_expected_slug_or_a_clean_not_found():
    case = batch_case(expect="not_found_or_slug")
    assert extension_batch.judge(case, batch_result(), None) == ("PASS", "配到預期商品")
    wrong = batch_result(urls=[f"{BATCH_PRODUCT}/../windforce", ""])
    assert batch_verdict(case, wrong) == "FAIL"
    empty = batch_result(status="找不到這個裝備", rows=[0, 0], pills=["NOT_RUN", "NOT_RUN"])
    assert extension_batch.judge(case, empty, None) == ("PASS", "找不到（可接受）")


def test_batch_judge_never_turns_a_known_gap_into_a_failure():
    case = batch_case(expect="known_gap")
    assert extension_batch.judge(case, batch_result(), None) == ("GAP", "全部通過")
    verdict, reason = extension_batch.judge(case, batch_result(pills=["FAILED", "PASSED"]), None)
    assert verdict == "GAP" and reason


@pytest.mark.parametrize(
    "broken,needle",
    [
        ({"pills": ["FAILED", "PASSED"]}, "狀態"),
        ({"rows": [0, 2]}, "狀態"),
        ({"status": "已停止"}, "狀態"),
        ({"urls": ["https://www.traderie.com/diablo2resurrected/product/windforce", ""]}, "商品網址"),
        ({"lookup": "查詢方式：站內搜尋"}, "查詢方式"),
    ],
)
def test_batch_judge_fails_the_pass_case_when_one_fact_is_wrong(broken, needle):
    verdict, reason = extension_batch.judge(batch_case(), batch_result(**broken), None)
    assert verdict == "FAIL" and needle in reason


def test_batch_judge_requires_load_more_to_have_loaded_more_listings():
    case = batch_case(load_more=5)
    assert batch_verdict(case, batch_result(rows=[60, 2])) == "PASS"
    verdict, reason = extension_batch.judge(case, batch_result(rows=[30, 2]), None)
    assert verdict == "FAIL" and "載入更多" in reason


def test_batch_judge_allows_an_empty_market_only_when_the_case_says_so():
    assert batch_verdict(batch_case(), batch_result(rows=[0, 0])) == "FAIL"
    assert batch_verdict(batch_case(allow_empty=True), batch_result(rows=[0, 0])) == "PASS"


def test_batch_judge_checks_that_a_double_click_spent_only_one_query():
    case = batch_case(double_click=True)
    assert batch_verdict(case, batch_result(quota="已用 4/100"), 3) == "PASS"
    verdict, reason = extension_batch.judge(case, batch_result(quota="已用 5/100"), 3)
    assert verdict == "FAIL" and "額度" in reason
    assert batch_verdict(case, batch_result(quota="—"), 3) == "FAIL"

# --- demo_e2e.verdict (the demo page's result rendering) -----------------------------------------------------


def demo_report() -> dict:
    """What scripts/demo_e2e.py reads out of the rendered page: three listings and two trades, in the page's own
    shapes (a price cell that carries both names, a seller name holding `|` and a newline, one row whose environment
    parts are all empty). verdict() -> []."""
    return {
        "tab": "查詢結果（掛單 3・成交 2）",
        "status": "兩段資料已讀取並通過檢查 · 可按「產生報告」",
        "tables": [
            {"width": 566.0, "rows": [
                ["賣家", "要價 / 高符文價值", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦", "遊戲版本"],
                ["a|b\nc", "1 Vex Rune", "Vex", "3 days ago", "PC / Softcore / Ladder", "141", "D2R"],
                ["賣家二", "Ist", "—", "2 days ago", "—", "—", "Classic (Base Game)"],
                ["Third", "Pul", "Pul", "1 day ago", "Playstation / Hardcore / Ladder", "0", "D2R"],
            ]},
            {"width": 366.0, "rows": [
                ["成交物品", "成交價格", "成交時間", "平台 / 模式 / 天梯", "遊戲版本"],
                ["They Give", "1 Um", "5 hours ago", "PC / Softcore / Ladder", "D2R"],
                ["I Give", "1 Mal", "1 day ago", "Xbox / Hardcore / Non Ladder", "D2R"],
            ]},
        ],
        "merged": ["高符文價值", "Vex", "—", "Pul"],
        "csv": 2,
        "details": 5,
        # The choice list's element indices and the overlay boxes' numbers: `action_space` skipped the fourth raw
        # action (the third same-name button), so the third index is 3 and no box carries a 4.
        "choices": ["1", "2", "3"],
        "targets": ["1", "2", "3"],
    }


def test_demo_verdict_accepts_the_page_it_expects():
    assert demo_e2e.verdict(demo_report()) == []


def _demo_no_switch(report):
    report["tab"] = "查詢過程"


def _demo_one_table(report):
    report["tables"] = report["tables"][:1]


def _demo_narrow_left(report):
    report["tables"][0]["width"] = 300.0


def _demo_six_columns(report):
    report["tables"][0]["rows"][0].pop()


def _demo_mangled_seller(report):
    # A newline collapsed to a space, or a value that lost its text: the row's raw text is the assertion.
    report["tables"][0]["rows"][1][0] = "a|b c"


def _demo_environment_not_joined(report):
    report["tables"][0]["rows"][3][4] = "Ladder"


def _demo_without_the_merge(report):
    report["merged"] = ["高符文價值"]


def _demo_one_csv(report):
    report["csv"] = 1


def _demo_one_details(report):
    report["details"] = 1


def _demo_no_verification_line(report):
    report["status"] = "準備開始探索"


def _demo_overlay_position_numbered(report):
    # The overlay numbered every rect-bearing node, not just the choice list's elements: the skipped fourth action got
    # a box of its own, so there are four boxes 1, 2, 3, 4 against the choice list's three (1, 2, 3).
    report["targets"] = ["1", "2", "3", "4"]


@pytest.mark.parametrize(
    ("mutation", "needle"),
    [
        pytest.param(_demo_no_switch, "沒有自動切到查詢結果", id="no-auto-switch"),
        pytest.param(_demo_one_table, "應該有兩張表", id="one-table"),
        pytest.param(_demo_narrow_left, "掛單在左且較寬", id="left-not-wider"),
        pytest.param(_demo_six_columns, "欄數應為 7 與 5", id="six-columns"),
        pytest.param(_demo_mangled_seller, "以文字呈現", id="mangled-seller"),
        pytest.param(_demo_environment_not_joined, "環境欄", id="environment-not-joined"),
        pytest.param(_demo_without_the_merge, "併在要價下", id="no-merge"),
        pytest.param(_demo_one_csv, "匯出 CSV", id="one-csv"),
        pytest.param(_demo_one_details, "網頁原文", id="one-details"),
        pytest.param(_demo_no_verification_line, "通過檢查", id="no-verification-line"),
        pytest.param(_demo_overlay_position_numbered, "覆蓋框的編號", id="overlay-position-numbered"),
    ],
)
def test_demo_verdict_reports_exactly_the_single_broken_assertion(mutation, needle):
    report = demo_report()
    mutation(report)
    assert needle in only_failure(demo_e2e.verdict(report))


# --- probe_stats.param_changed_the_list (what a filter address did to the list) ----------------------------

def test_a_tag_page_counts_as_filtered_when_its_names_differ_from_the_unfiltered_page():
    # The regression this pins: the old rule required every listed name to contain "ring", which no page carrying
    # unique rings (Angelic Halo, Nagelring, Dwarf Star) can satisfy, so it called the tag parameter dead while the
    # page was in fact filtered to rings.
    tagged = ["Angelic Halo", "Blood Ring", "Nagelring", "Dwarf Star", "Caster Ring"]
    unfiltered = ["Amulet", "Angelic Halo", "Archon Plate", "Caster Amulet", "Chain Boots"]
    assert probe_stats.param_changed_the_list(tagged, unfiltered) is True


def test_the_same_names_with_and_without_the_parameter_are_not_a_filtered_page():
    names = ["Amulet", "Archon Plate", "Chain Boots"]
    assert probe_stats.param_changed_the_list(names, names) is False


def test_a_page_that_did_not_load_is_not_a_filtered_page():
    assert probe_stats.param_changed_the_list([], ["Amulet", "Archon Plate"]) is False


# --- probe_blocking.verdict (whether a run's own numbers can be trusted) -----------------------------------

def _ab_row(blocked, settle_ms, navigate_ms=300):
    return {
        "blocked": blocked,
        "settle_capped": False,
        "navigate_ms": navigate_ms,
        "settle_ms": settle_ms,
        "total_ms": navigate_ms + settle_ms,
        "ad_blocked": 1 if blocked else 0,
        "ad_served": 0 if blocked else 3,
        "ad_last_ms": None if blocked else navigate_ms + 50,  # the premise: they landed during the settle
    }


def _ab_pairs(specs):
    """Rows for alternating ON/OFF runs, one (blocked settle, unblocked settle) per pair."""
    rows = []
    for on_settle, off_settle in specs:
        rows += [_ab_row(True, on_settle), _ab_row(False, off_settle)]
    return rows


def test_a_five_pair_run_cannot_be_read_as_a_verdict():
    # The trap this pins: the first 5-pair run here looked like 4 of 5 pairs settling 33% faster, and a 12-pair run
    # then found nothing at all. The verdict is allowed, but it must say out loud that the sample cannot carry it.
    result, why = probe_blocking.verdict(_ab_pairs([(1600, 2000)] * 5))
    assert result == "supported"
    assert "only 5 pairs" in why
    assert "--pairs 8" in why


def test_enough_pairs_carry_the_verdict_without_the_note():
    result, why = probe_blocking.verdict(_ab_pairs([(1600, 2000)] * 10))
    assert result == "supported"
    assert "only" not in why


def test_the_real_twelve_pair_shape_is_inconclusive_and_needs_no_note():
    # The deltas a real 12-pair run produced (OFF - ON, ms): scattered either side of zero.
    deltas = [-66, 13, -6, -41, -13, -1, 71, -63, 65, -21, 81, -97]
    result, why = probe_blocking.verdict(_ab_pairs([(1700, 1700 + d) for d in deltas]))
    assert result == "inconclusive"
    assert "only" not in why


def test_scan_verdict_fails_when_picked_names_were_not_remembered_by_the_settings_block():
    report = scan_report()
    report["learn_count"] = "還沒有記住任何更正。"
    failures = scan_e2e.verdict(report)
    assert len(failures) == 1 and "學習紀錄" in failures[0]
    report["learn_count"] = "已記住 3 筆更正（其中 0 筆選過 2 次以上，下次會自動填入）。"
    assert scan_e2e.verdict(report) == []
