"""Offline tests of the pure parts of the Chrome end-to-end scripts (`scripts/extension_e2e.py`, `scan_e2e.py`,
`ocr_e2e.py`).

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
from scripts import extension_e2e, ocr_e2e, scan_e2e

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


def stub_chooser(lines=None) -> extension_e2e.StubChooser:
    """A StubChooser that appends its log lines to `lines` (the run prints them; here they are read back)."""
    return extension_e2e.StubChooser(log=(lines if lines is not None else []).append)


def test_stub_phase_reads_the_phase_out_of_the_goal_the_backend_builds():
    assert [extension_e2e.stub_phase(goal) for goal in phase_goals()] == ["trading", "recent_trades"]
    assert extension_e2e.stub_phase("no phase line") == "trading"  # the only safe guess; the log shows its page


def test_goal_batches_reads_the_requested_presses_and_zero_when_none_are_asked_for():
    assert [extension_e2e.goal_batches(goal) for goal in phase_goals(3)] == [3, 3]
    assert [extension_e2e.goal_batches(goal) for goal in phase_goals(0)] == [0, 0]


def test_stub_decision_has_the_shape_choose_step_passes_on():
    # The keys tests/test_services.py's stub chooser returns, plus latency_ms (agent.history records it).
    answer = extension_e2e.stub_decision("DONE", "DONE", {"DONE": 1.0})
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
    chooser = extension_e2e.StubChooser(log=lines.append)
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
    routes = extension_e2e.stub_routes(extension_e2e.StubChooser(log=log.append))
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


# --- scan_e2e.verdict -------------------------------------------------------------------------------------


def scan_report() -> dict:
    """A complete scan report: the four simulated records, both per-record buttons, no query. verdict() -> []."""
    expects = ["Alma Negra", "Grand Charm", "Harlequin Crest", "Stormshield"]
    # `records` is what the panel's STATE probe collects from `#scan-list li`: one string per record, the concatenated
    # textContent of the name line, the `HH:MM:SS · 類型 · 詞綴` line and the two button labels (scripts/scan_e2e.py).
    records = [f"{name} 00:00:0{i} · 暗金 · 力量＋20 精準搜尋 模糊搜尋" for i, name in enumerate(expects)]
    return {
        "expects": expects,
        "base_name": "Grand Charm",
        "record_count": len(expects),
        "records": records,
        "names": list(expects),
        "csv_enabled": True,
        "exact_clicks": [
            {"name": name, "outcome": "clicked", "mode": "name", "view": "ready", "item": name}
            for name in expects
        ],
        "fuzzy_item": {"outcome": "clicked", "mode": "stats", "view": "ready", "ticks": 2, "statsBase": ""},
        "fuzzy_base": {
            "outcome": "clicked",
            "mode": "stats",
            "view": "ready",
            "ticks": 0,
            "statsBase": "Grand Charm",
        },
        "banner": "",
        "views": [["scan", ""], ["stats", ""]],
    }


def test_scan_verdict_accepts_a_report_that_matches_every_section_6_assertion():
    assert scan_e2e.verdict(scan_report()) == []


def _count_wrong(report):
    report["record_count"] = 3


def _name_set_wrong(report):
    report["names"][2] = "Something Else"


def _duplicate_name(report):
    report["expects"][1] = "Alma Negra"
    report["names"][1] = "Alma Negra"


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
    report["fuzzy_item"]["ticks"] = 0


def _fuzzy_item_prefilled_base(report):
    report["fuzzy_item"]["statsBase"] = "Ring"


def _fuzzy_item_missing(report):
    del report["fuzzy_item"]


def _fuzzy_base_mode_wrong(report):
    report["fuzzy_base"]["mode"] = "name"


def _fuzzy_base_not_filled(report):
    report["fuzzy_base"]["statsBase"] = ""


def _banner_shown(report):
    report["banner"] = "查詢橫幅"


def _view_ran_a_query(report):
    report["views"].append(["running", "stats"])


@pytest.mark.parametrize(
    ("mutate", "token"),
    [
        pytest.param(_count_wrong, "3", id="record-count"),
        pytest.param(_name_set_wrong, "Something Else", id="name-set"),
        pytest.param(_duplicate_name, "Alma Negra", id="duplicate-name"),
        pytest.param(_csv_disabled, "scan-csv", id="csv-disabled"),
        pytest.param(_exact_outcome_wrong, "Grand Charm", id="exact-click-outcome"),
        pytest.param(_exact_mode_wrong, "Grand Charm", id="exact-click-mode"),
        pytest.param(_exact_view_wrong, "Grand Charm", id="exact-click-view"),
        pytest.param(_exact_item_wrong, "Grand Charm", id="exact-click-item"),
        pytest.param(_fuzzy_item_outcome_wrong, "no-record", id="fuzzy-item-outcome"),
        pytest.param(_fuzzy_item_mode_wrong, "'mode': 'name'", id="fuzzy-item-mode"),
        pytest.param(_fuzzy_item_view_wrong, "'view': 'running'", id="fuzzy-item-view"),
        pytest.param(_fuzzy_item_no_tick, "'ticks': 0", id="fuzzy-item-no-tick"),
        pytest.param(_fuzzy_item_prefilled_base, "Ring", id="fuzzy-item-prefilled-base"),
        pytest.param(_fuzzy_item_missing, "None", id="fuzzy-item-missing"),
        pytest.param(_fuzzy_base_mode_wrong, "'mode': 'name'", id="fuzzy-base-mode"),
        pytest.param(_fuzzy_base_not_filled, "stats-base", id="fuzzy-base-not-filled"),
        pytest.param(_banner_shown, "橫幅", id="banner-shown"),
        pytest.param(_view_ran_a_query, "running", id="view-ran-a-query"),
    ],
)
def test_scan_verdict_reports_exactly_the_single_broken_assertion(mutate, token):
    report = scan_report()
    mutate(report)
    failures = scan_e2e.verdict(report)
    assert len(failures) == 1, failures
    assert token in failures[0]


# --- ocr_e2e.verdict --------------------------------------------------------------------------------------


def ocr_report() -> dict:
    """The recorded shape of artifacts/ocr-e2e/report.json: every group present and passing."""
    return {
        "download": {
            "no_consent_element": True,
            "notice_shown": True,
            "requests_started_by_themselves": True,
            "download_without_a_click": True,
            "progress_bar_seen": True,
            "cancel_stops_download": True,
            "cancel_needs_no_retry": True,
            "only_fixed_urls": True,
            "second_run_no_download": True,
            "after_reload_no_download": True,
            "blocked_is_clear": True,
            "blocked_not_retried": True,
            "progress_seen": [10, 90],
        },
        "accuracy": {"scored": 22, "top1": 21, "top3": 22, "screenshots_top3": 18, "phone_top3": 4},
        "accuracy_holdout": {"scored": 30, "top1": 22, "top3": 29, "screenshots_top3": 17, "phone_top3": 12},
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
            "values_empty": True,
            "no_query_started": True,
            "start_gate_with_empty_values": {"disabled": True, "whyVisible": True},
            "start_enabled_after_value": {"disabled": False, "whyVisible": False},
        },
    }


ACCURACY_FLOORS = {"scored": 22, "top1": 20, "top3": 21, "screenshots_top3": 17, "phone_top3": 4}
HOLDOUT_FLOORS = {"scored": 30, "top1": 22, "top3": 26, "screenshots_top3": 16, "phone_top3": 10}


def test_ocr_verdict_accepts_a_report_that_meets_every_floor_and_flag():
    assert ocr_e2e.verdict(ocr_report(), ACCURACY_FLOORS, HOLDOUT_FLOORS) == []


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
        "notice_shown",
        "requests_started_by_themselves",
        "download_without_a_click",
        "progress_bar_seen",
        "cancel_stops_download",
        "cancel_needs_no_retry",
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
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert key in failures[0]


def test_ocr_verdict_rejects_a_download_with_no_progress_seen():
    report = ocr_report()
    report["download"]["progress_seen"] = []
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert "進度" in failures[0]


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
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert key in failures[0]


@pytest.mark.parametrize(
    "key", ["label_ok", "rows_present", "all_mapped_on", "values_empty", "no_query_started"]
)
def test_ocr_verdict_rejects_an_affix_check_that_is_not_true(key):
    report = ocr_report()
    report["affix"][key] = False
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert key in failures[0]


@pytest.mark.parametrize("gate", [{"disabled": False, "whyVisible": True}, {"disabled": True, "whyVisible": False}])
def test_ocr_verdict_rejects_an_affix_start_gate_that_is_not_blocked_with_a_reason(gate):
    report = ocr_report()
    report["affix"]["start_gate_with_empty_values"] = gate
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert "start_gate_with_empty_values" in failures[0]


def test_ocr_verdict_rejects_a_start_that_stayed_disabled_after_filling_a_value():
    report = ocr_report()
    report["affix"]["start_enabled_after_value"] = {"disabled": True, "whyVisible": True}
    failures = ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS)
    assert len(failures) == 1, failures
    assert "start_enabled_after_value" in failures[0]


def test_ocr_verdict_accepts_an_unmeasured_start_enabled_check():
    # A bool-only affix row has no number box, so start_enabled_after_value is never measured (None).
    report = ocr_report()
    report["affix"]["start_enabled_after_value"] = None
    assert ocr_e2e.verdict(report, floors=ACCURACY_FLOORS, holdout=HOLDOUT_FLOORS) == []


def test_scan_and_ocr_verdicts_are_pure():
    report = scan_report()
    ocr = ocr_report()
    scan_e2e.verdict(report)
    ocr_e2e.verdict(ocr, ACCURACY_FLOORS, HOLDOUT_FLOORS)
    assert report == scan_report() and ocr == ocr_report()
