import base64
import json

import pytest

from benchmarks import paired_selector as paired


class Response:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload
        self.content = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def json(self):
        return self.payload


class ProviderClient:
    def __init__(self, response=None, generation=None, post_error=None):
        self.response = response or {
            "id": "generation-1",
            "model": paired.MERCURY_MODEL,
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }
        self.generation = generation or {
            "data": {
                "id": "generation-1",
                "model": paired.MERCURY_MODEL,
                "total_cost": 0.00001,
                "tokens_prompt": 10,
                "tokens_completion": 2,
            }
        }
        self.post_error = post_error
        self.calls = []

    def post(self, url, *, content, headers, follow_redirects):
        self.calls.append(("post", url, json.loads(content), headers, follow_redirects))
        if self.post_error:
            raise self.post_error
        return Response(self.response)

    def get(self, url, *, params, headers, follow_redirects):
        self.calls.append(("get", url, params, headers, follow_redirects))
        return Response(self.generation)


def make_meter(tmp_path, monkeypatch, client):
    request_log = tmp_path / "requests.jsonl"
    ledger = tmp_path / "spend-ledger.jsonl"
    monkeypatch.setattr(paired, "REQUEST_LOG_PATH", request_log)
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", True)
    meter = paired.CostMeter(client, "private-test-key", ledger_path=ledger)
    meter.arm = "conventional"
    meter.reserve_pair("pilot:filter_select", "pilot")
    return meter, request_log, ledger


def functional_call(arm, kind="selector"):
    model_id = paired.JEV_MODEL if arm == "jev" and kind == "selector" else paired.MERCURY_MODEL
    bound = paired.JEV_CALL_BOUND if model_id == paired.JEV_MODEL else paired.MERCURY_CALL_BOUND
    return {
        "test_only_authorization_id": paired.TEST_ONLY_AUTHORIZATION_ID,
        "arm": arm,
        "kind": kind,
        "attempt_id": f"{arm}-{kind}-attempt",
        "model_requested": model_id,
        "model": model_id,
        "generation_model": None,
        "generation_total_cost_usd": None,
        "generation_lookup_attempts": 0,
        "generation_cost_reconciled": False,
        "endpoint": (
            "openrouter.ai/api/alpha/decisions"
            if model_id == paired.JEV_MODEL
            else "openrouter.ai/api/v1/chat/completions"
        ),
        "cost_basis": paired.TEST_ONLY_FUNCTIONAL_COST_MODE,
        "error": None,
        "http_attempts": 1,
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        "response_cost_usd": 0.00001,
        "max_input_tokens_reserved": paired.INPUT_TOKEN_RESERVE,
        "max_output_tokens_reserved": 0 if model_id == paired.JEV_MODEL else paired.MERCURY_OUTPUT_RESERVE,
        "request_sha256": "a" * 64,
        "request_bytes": 100,
        "status": 200,
        "conservative_charged_usd": bound,
    }


def test_budget_schedule_and_phase_pair_ids_are_bounded_and_disjoint():
    pilot = paired._pair_plan("pilot")
    main = paired._pair_plan("main")
    pair_ids = [pair_id for pair_id, _seed, _family in pilot + main]

    assert paired.MAIN_PAIRS == 2627
    assert paired.REVIEW_SPEND_USD == 7.931816
    assert len(main) == paired.MAIN_PAIRS
    assert len(set(pair_ids)) == len(pair_ids)
    assert {family for _pair_id, _seed, family in pilot} == set(paired.FAMILIES)
    assert {family for _pair_id, _seed, family in main} == set(paired.FAMILIES)
    assert paired.REVIEW_SPEND_USD + paired.PAIR_BOUND * (paired.MAIN_PAIRS + len(pilot)) > paired.STOP_USD


def test_machine_readable_protocol_matches_runner_constants():
    protocol = json.loads(paired.PROTOCOL_PATH.read_text())

    assert protocol["sampling"]["main_pairs"] == paired.MAIN_PAIRS
    assert protocol["sampling"]["main_family_allocation"] == paired.FAMILY_COUNTS
    assert protocol["sampling"]["pilot_pairs"] == len(paired.FAMILIES)
    assert protocol["metering"]["already_spent_cross_model_review_usd"] == paired.REVIEW_SPEND_USD
    assert protocol["metering"]["request_body_max_bytes"] == paired.REQUEST_MAX_BYTES == 16384
    assert protocol["metering"]["reserved_input_tokens_per_request"] == paired.INPUT_TOKEN_RESERVE == 16384
    assert protocol["metering"]["conservative_bound_per_pair_usd"] == pytest.approx(paired.PAIR_BOUND)
    assert protocol["metering"]["projected_pilot_plus_main_usd"] == pytest.approx(
        paired.PAIR_BOUND * (paired.MAIN_PAIRS + len(paired.FAMILIES))
    )
    assert protocol["run_policy"]["single_runnable_provider_benchmark"] == "benchmarks/paired_selector.py"
    assert protocol["run_policy"]["provider_inference_enabled"] is False
    assert paired.JEV_CALL_BOUND == pytest.approx(0.000688128)
    assert paired.MERCURY_CALL_BOUND == pytest.approx(0.00067456)
    assert paired.PAIR_BOUND == pytest.approx(0.016297984)
    assert protocol["run_policy"]["test_only_task_failure_continuation"]["pairs"] == 5
    assert protocol["run_policy"]["test_only_task_failure_continuation"]["smoke_rerun"] is False
    assert (
        protocol["run_policy"]["test_only_task_failure_continuation"]["resume_after_pre_send_request_bound_stop"][
            "one_active_run_authorization"
        ]
        is True
    )
    assert (
        protocol["run_policy"]["test_only_task_failure_continuation"]["single_pre_provider_recovery"][
            "max_recoveries"
        ]
        == 1
    )
    assert (
        protocol["run_policy"]["test_only_task_failure_continuation"]["single_pre_provider_recovery"][
            "preserve_prior_attempt_marker_result_and_stop"
        ]
        is True
    )
    assert (
        protocol["run_policy"]["test_only_task_failure_continuation"]["enables_main_sample_or_global_provider_inference"]
        is False
    )


def test_mercury_selector_adapter_matches_native_decision_heads():
    questions = {
        "operation": {"criteria": {"CLICK": "Click a control", "DONE": "Finish"}},
        "click_target": {"criteria": {"1": {"element": "Search"}, "2": {"element": "Exact result"}}},
    }
    request = paired.CostMeter._selector_request(
        {"model": paired.MERCURY_MODEL, "state": {"page": {"text": "Search"}}, "questions": questions}
    )
    transported_questions = json.loads(request["messages"][1]["content"])["questions"]
    assert transported_questions == questions
    assert request["model"] == paired.MERCURY_MODEL
    assert request["response_format"] == {"type": "json_object"}

    native_answers = {
        "operation": {"choice": "CLICK", "confidence": 1.0, "probabilities": {"CLICK": 1.0, "DONE": 0.0}},
        "click_target": {"choice": "2", "confidence": 1.0, "probabilities": {"1": 0.0, "2": 1.0}},
    }
    response = {
        "choices": [{"message": {"content": json.dumps({"operation": "CLICK", "target": "2"})}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
    }

    adapted = paired.CostMeter._selector_envelope(request, response)

    assert adapted["answers"] == native_answers
    assert paired.model_module.validate_choice(adapted["answers"]["operation"], ["CLICK", "DONE"])
    assert paired.model_module.validate_choice(adapted["answers"]["click_target"], ["1", "2"])


def test_mercury_selector_adapter_rejects_targets_outside_the_offered_schema():
    request = paired.CostMeter._selector_request(
        {
            "questions": {
                "operation": {"criteria": {"CLICK": "Click"}},
                "click_target": {"criteria": {"1": {"element": "Search"}}},
            }
        }
    )
    response = {"choices": [{"message": {"content": '{"operation":"CLICK","target":"9"}'}}]}

    with pytest.raises(ValueError, match="invalid or illegal operation/target"):
        paired.CostMeter._selector_envelope(request, response)


def test_smoke_continuation_gate_accepts_only_safe_metered_task_failures():
    jev_call = functional_call("jev")
    mercury_call = functional_call("conventional")
    jev = {
        "arm": "jev",
        "complete": True,
        "status": "done",
        "loopback_origin_preserved": True,
        "oracle": {"passed": True},
        "errors": [],
        "safety_violations": [],
        "provider_calls": [jev_call],
    }
    conventional = {
        "arm": "conventional",
        "complete": False,
        "status": "blocked",
        "loopback_origin_preserved": True,
        "oracle": {"passed": False},
        "errors": [{"phase": "decision", "type": "ValueError", "message": "Decision response rejected."}],
        "safety_violations": [],
        "provider_calls": [mercury_call],
    }
    pair = {
        "phase": "smoke",
        "pair_id": f"smoke:{paired.FAMILIES[0]}",
        "family": paired.FAMILIES[0],
        "complete_pair": True,
        "stop_reason": "fixture/oracle or arm failure",
        "provider_errors": [],
        "safety_violations": [],
        "provider_calls": [jev_call, mercury_call],
        "arms": {"jev": jev, "conventional": conventional},
    }
    stops = [{"after_pair": pair["pair_id"], "reason": pair["stop_reason"]}]
    summary = {"status": "SMOKE_FAILED", "smoke_gate": {"passed": False}}

    assert paired._test_only_smoke_continuation_gate(pair, stops, summary)["passed"]
    conventional["errors"][0]["phase"] = "browser"
    assert not paired._test_only_smoke_continuation_gate(pair, stops, summary)["passed"]


def test_five_pair_integrity_gate_retains_safe_task_failures():
    records = []
    for family in paired.FAMILIES:
        arms = {}
        calls = []
        for name in ("jev", "conventional"):
            call = functional_call(name)
            calls.append(call)
            failed = family == paired.FAMILIES[0] and name == "conventional"
            arms[name] = {
                "arm": name,
                "complete": not failed,
                "status": "blocked" if failed else "done",
                "loopback_origin_preserved": True,
                "oracle": {"passed": not failed},
                "errors": [{"phase": "decision", "type": "ValueError"}] if failed else [],
                "safety_violations": [],
                "provider_calls": [call],
            }
        records.append(
            {
                "phase": "pilot",
                "pair_id": (
                    paired.TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID
                    if family == "form_preview"
                    else f"pilot:{family}"
                ),
                "family": family,
                "complete_pair": True,
                "arms": arms,
                "provider_calls": calls,
                "provider_errors": [],
                "safety_violations": [],
            }
        )

    gate = paired._pilot_attempt_integrity_gate(
        records,
        incremental_upper_spend_usd=0.05,
        provider_calls_total=10,
    )

    assert gate["passed"]
    records[0]["arms"]["conventional"]["safety_violations"] = ["left loopback origin"]
    assert not paired._pilot_attempt_integrity_gate(
        records,
        incremental_upper_spend_usd=0.05,
        provider_calls_total=10,
    )["passed"]


def test_budget_gate_accepts_predeclared_legacy_and_revised_request_bounds():
    revised = functional_call("jev")
    legacy = functional_call("jev")
    legacy["max_input_tokens_reserved"] = paired.LEGACY_INPUT_TOKEN_RESERVE
    legacy["max_output_tokens_reserved"] = 0
    legacy["conservative_charged_usd"] = paired._call_bound(paired.JEV_MODEL, paired.LEGACY_INPUT_TOKEN_RESERVE)
    legacy.pop("request_max_bytes", None)

    assert paired._provider_call_budgeted(revised)
    assert paired._provider_call_budgeted(legacy)


def test_authorized_pilot_has_a_prebounded_incremental_reserve():
    assert paired.TEST_ONLY_MAX_PILOT_PAIRS == len(paired.FAMILIES) == 5
    assert paired.TEST_ONLY_MAX_RUN_PAIRS == 6
    assert paired.TEST_ONLY_MAX_PROVIDER_CALLS == 96
    assert paired.TEST_ONLY_MAX_RUN_PAIRS * paired.PAIR_BOUND < paired.TEST_ONLY_INCREMENTAL_CAP_USD == 2.0
    run_id = "0123456789abcdef0123456789abcdef"
    output_dir = paired.TEST_ONLY_OUTPUT_ROOT / f"{paired.TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    authorization = paired._test_only_authorization_record(run_id, output_dir)
    assert authorization["run_id"] == run_id
    assert authorization["output_dir"] == str(output_dir)
    assert authorization["historical_total_spend_usd"] is None
    assert authorization["historical_total_reconciled"] is False
    assert authorization["original_total_cap_compliance_confirmed"] is False


def test_smoke_only_authorization_includes_all_prior_jev_reserves_and_forbids_pilot():
    run_id = "0123456789abcdef0123456789abcdef"
    output_dir = paired.TEST_ONLY_OUTPUT_ROOT / f"{paired.TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    authorization = paired._test_only_authorization_record(run_id, output_dir, include_pilot=False)

    assert authorization["max_pilot_pairs"] == 0
    assert authorization["max_run_pairs_including_smoke"] == 1
    assert authorization["max_provider_calls_total"] == paired.TEST_ONLY_MAX_CALLS_PER_PAIR
    assert authorization["prior_reserved_usd"] == 0.000688128
    assert authorization["full_smoke_plus_pilot_rate_bound_usd"] == pytest.approx(
        paired.TEST_ONLY_PRIOR_RESERVED_USD + paired.PAIR_BOUND
    )
    assert "no pilot pairs" in authorization["scope"]


def test_test_only_smoke_arm_order_is_jev_then_conventional():
    assert paired._arm_order_for_run("smoke:autocomplete_search", "smoke", True) == ["jev", "conventional"]
    assert paired._arm_order_for_run("pilot:filter_select", "pilot", True) == paired._arm_order(
        "pilot:filter_select"
    )


def test_authorized_smoke_runner_executes_only_one_smoke_and_is_one_shot(tmp_path, monkeypatch):
    marker = tmp_path / "smoke-retry-used.json"
    monkeypatch.setattr(paired, "TEST_ONLY_OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(paired, "TEST_ONLY_SMOKE_RETRY_MARKER", marker)
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "private-test-key")
    calls = []

    def fake_benchmark_locked(mode, count, output_dir, authorization):
        calls.append(mode)
        assert mode == "smoke"
        assert count == 1
        assert authorization["max_pilot_pairs"] == 0
        paired.OUT_DIR = output_dir
        paired.RAW_PATH = output_dir / "pairs.jsonl"
        paired.SUMMARY_PATH = output_dir / "summary.json"
        paired.MANIFEST_PATH = output_dir / "manifest.json"
        paired.REQUEST_LOG_PATH = output_dir / "requests.jsonl"
        summary = {
            "phase": "smoke",
            "batch_pairs_completed": 1,
            "incremental_new_spend_usd": paired.TEST_ONLY_PRIOR_RESERVED_USD,
        }
        paired.SUMMARY_PATH.write_text(json.dumps(summary), encoding="utf-8")
        return summary

    monkeypatch.setattr(paired, "_run_benchmark_locked", fake_benchmark_locked)
    monkeypatch.setattr(paired, "_read_records", lambda _path: [{"phase": "smoke"}])
    monkeypatch.setattr(paired, "_test_only_smoke_gate", lambda _record: {"passed": True})

    summary = paired.run_test_only_authorized_smoke()

    assert calls == ["smoke"]
    assert summary["status"] == "SMOKE_PASSED"
    assert summary["pilot_execution"] == "not authorized for this run"
    assert summary["prior_reserved_usd"] == paired.TEST_ONLY_PRIOR_RESERVED_USD
    assert marker.is_file()
    with pytest.raises(paired.MeteringError, match="single corrected smoke retry was already consumed"):
        paired.run_test_only_authorized_smoke()
    assert calls == ["smoke"]


def test_smoke_pair_has_its_own_id_and_does_not_consume_a_pilot_pair():
    smoke = paired._pair_plan("smoke")
    pilot = paired._pair_plan("pilot")

    assert smoke == [(f"smoke:{paired.FAMILIES[0]}", paired.TEST_ONLY_SMOKE_SEED, paired.FAMILIES[0])]
    assert len(pilot) == paired.TEST_ONLY_MAX_PILOT_PAIRS
    assert {pair_id for pair_id, _seed, _family in smoke}.isdisjoint(
        pair_id for pair_id, _seed, _family in pilot
    )


@pytest.mark.parametrize("family", paired.FAMILIES)
def test_protocol_fixture_is_deterministic_seeded_and_loopback_only(family):
    first = paired.make_trial(family, 17)
    again = paired.make_trial(family, 17)
    other = paired.make_trial(family, 18)

    assert first == again
    assert first["expected"] != other["expected"] or first["html"] != other["html"]
    assert "http://" not in first["html"]
    assert "https://" not in first["html"]


def test_arm_order_is_stable_and_balanced_across_unique_pair_ids():
    pair_ids = [f"main:{index:04d}" for index in range(200)]
    orders = [paired._arm_order(pair_id) for pair_id in pair_ids]

    assert orders == [paired._arm_order(pair_id) for pair_id in pair_ids]
    assert 80 <= sum(order[0] == "jev" for order in orders) <= 120


def test_single_runner_is_the_only_provider_benchmark_entrypoint():
    assert (paired.ROOT / "benchmarks" / "paired_selector.py").is_file()
    assert not (paired.ROOT / "benchmarks" / "paired_selector_benchmark.py").exists()


def test_jev_alpha_decisions_route_uses_exact_pinned_model_id():
    meter = type("Meter", (), {"api_key": "private-test-key"})()

    endpoint, _key, model_id = paired._provider_for(meter, "jev")

    assert endpoint == paired.model_module.OPENROUTER_DECISIONS_URL
    assert model_id == paired.JEV_MODEL == "typesafe/jev-1.13"
    assert not model_id.startswith("~")


def test_jev_decisions_request_uses_pinned_model_and_omits_chat_usage_extension(tmp_path, monkeypatch):
    client = ProviderClient(
        response={
            "id": "generation-jev",
            "model": paired.JEV_MODEL,
            "usage": {"prompt_tokens": 10, "completion_tokens": 0},
        },
        generation={
            "data": {
                "id": "generation-jev",
                "model": paired.JEV_MODEL,
                "total_cost": 0.00001,
                "tokens_prompt": 10,
                "tokens_completion": 0,
            }
        },
    )
    meter, _request_log, _ledger = make_meter(tmp_path, monkeypatch, client)
    meter.arm = "jev"
    meter.release_pair("pilot:filter_select")
    meter.reserve_pair("smoke:autocomplete_search", "smoke")
    request = {
        "model": paired.JEV_MODEL,
        "state": {"page": {"url": "http://127.0.0.1/fixture", "title": "Catalog", "text": "Search"}},
        "questions": {"operation": {"type": "choice", "instructions": "Choose", "criteria": {"DONE": "Done"}}},
    }

    result = meter.post_json(paired.model_module.OPENROUTER_DECISIONS_URL, "private-test-key", request)

    assert result["id"] == "generation-jev"
    assert client.calls[0][0:2] == ("post", paired.model_module.OPENROUTER_DECISIONS_URL)
    assert client.calls[0][2]["model"] == "typesafe/jev-1.13"
    assert "usage" not in client.calls[0][2]
    assert [call[0] for call in client.calls] == ["post", "get"]


def test_authorized_jev_decision_succeeds_without_generation_cost_metadata(tmp_path, monkeypatch):
    client = ProviderClient(
        response={
            "id": "generation-jev",
            "model": paired.JEV_MODEL + "-20260917",
            "usage": {"prompt_tokens": 10, "completion_tokens": 0},
            "answers": {
                "operation": {
                    "choice": "CLICK",
                    "confidence": 1,
                    "probabilities": {"CLICK": 1, "DONE": 0, "BLOCKED": 0},
                },
                "click_target": {"choice": "1", "confidence": 1, "probabilities": {"1": 1}},
            },
        }
    )

    def unavailable_metadata(url, *, params, headers, follow_redirects):
        client.calls.append(("get", url, params, headers, follow_redirects))
        return type("UnavailableResponse", (), {"status_code": 503})()

    client.get = unavailable_metadata
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
    monkeypatch.setattr(paired, "REQUEST_LOG_PATH", tmp_path / "requests.jsonl")
    meter = paired.CostMeter(
        client,
        "private-test-key",
        base_spend_usd=0,
        prior_spend_usd=0,
        prior_attempts=[],
        ledger_path=tmp_path / "spend-ledger.jsonl",
        test_only_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    meter.arm = "jev"
    meter.reserve_pair("smoke:autocomplete_search", "smoke")
    monkeypatch.setattr(
        paired.model_module,
        "decision_provider",
        lambda: (paired.model_module.OPENROUTER_DECISIONS_URL, "private-test-key", paired.JEV_MODEL),
    )
    monkeypatch.setattr(paired.model_module, "post_json", meter.post_json)

    decision = paired.model_module.choose(
        {
            "url": "http://127.0.0.1:8766/fixture",
            "title": "Catalog",
            "text": "Search",
            "actions": [{"id": "e1", "node": "node-1", "kind": "click", "label": "Search", "role": "button"}],
        },
        "Click Search",
        [],
    )

    settlements = [json.loads(line) for line in (tmp_path / "spend-ledger.jsonl").read_text().splitlines()]
    assert decision["choice"] == "e1"
    assert decision["operation"] == "CLICK"
    assert [call[0] for call in client.calls] == ["post"]
    assert meter.calls[0]["generation_lookup_attempts"] == 0
    assert meter.calls[0]["cost_basis"] == paired.TEST_ONLY_FUNCTIONAL_COST_MODE
    assert meter.calls[0]["conservative_charged_usd"] == pytest.approx(paired.JEV_CALL_BOUND)
    assert meter.calls[0]["generation_cost_reconciled"] is False
    assert meter.calls[0]["response_cost_usd"] == pytest.approx(10 * 0.042 / 1_000_000)
    assert paired._provider_call_budgeted(meter.calls[0])
    assert meter.calls[0]["error"] is None
    assert [row["event"] for row in settlements] == ["attempt", "settlement"]
    assert settlements[-1]["charged_usd"] == pytest.approx(paired.JEV_CALL_BOUND)
    assert settlements[-1]["error"] is None
    evidence = [
        json.loads(line) for line in (tmp_path / "model-evidence.jsonl").read_text().splitlines()
    ]
    assert len(evidence) == 1
    assert evidence[0]["raw_body_exact"] is True
    assert json.loads(base64.b64decode(evidence[0]["raw_body_base64"])) == client.response
    assert set(evidence[0]["offered_choices"]["operation"]["criteria"]) == {"CLICK", "DONE", "BLOCKED"}
    assert set(evidence[0]["offered_choices"]["click_target"]["criteria"]) == {"1"}


def test_success_reconciles_exact_generation_and_persists_spend_ledger(tmp_path, monkeypatch):
    client = ProviderClient()
    meter, request_log, ledger = make_meter(tmp_path, monkeypatch, client)

    response = meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert response["id"] == "generation-1"
    assert [call[0] for call in client.calls] == ["post", "get"]
    assert client.calls[0][1] == paired.CHAT_URL
    assert client.calls[0][2]["max_tokens"] == paired.MERCURY_OUTPUT_RESERVE
    assert client.calls[0][2]["usage"] == {"include": True}
    assert client.calls[0][4] is False and client.calls[1][4] is False
    assert meter.calls[0]["generation_model"] == paired.MERCURY_MODEL
    assert meter.calls[0]["generation_total_cost_usd"] == pytest.approx(0.00001)
    assert meter.calls[0]["cost_basis"] == "openrouter-generation-total_cost"
    assert [json.loads(line)["event"] for line in ledger.read_text().splitlines()] == ["attempt", "settlement"]
    assert "private-test-key" not in request_log.read_text()
    resumed = paired.CostMeter(client, "private-test-key", ledger_path=ledger)
    assert resumed.charged_usd == pytest.approx(0.00001)
    assert resumed.prior_attempts[0]["pair_id"] == "pilot:filter_select"


def test_oversized_request_is_refused_before_network_or_ledger_write(tmp_path, monkeypatch):
    client = ProviderClient()
    meter, request_log, ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.MeteringError, match=f"{paired.REQUEST_MAX_BYTES}-byte bound"):
        meter.post_json(
            paired.CHAT_URL,
            "private-test-key",
            {"messages": [{"content": "x" * (paired.REQUEST_MAX_BYTES + 1)}]},
        )

    assert client.calls == []
    assert not request_log.exists()
    assert not ledger.exists()


def test_unexpected_provider_route_is_refused_before_network(tmp_path, monkeypatch):
    client = ProviderClient()
    meter, _request_log, ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.MeteringError, match="Unexpected provider route"):
        meter.post_json("https://example.invalid/chat/completions", "private-test-key", {"messages": []})

    assert client.calls == []
    assert not ledger.exists()


def test_interrupted_attempt_is_reserved_durably_and_blocks_resume(tmp_path, monkeypatch):
    client = ProviderClient(post_error=SystemExit("simulated process interruption"))
    meter, _request_log, ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(SystemExit, match="simulated process interruption"):
        meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert json.loads(ledger.read_text().strip())["event"] == "attempt"
    with pytest.raises(paired.MeteringError, match="unsettled in the durable ledger"):
        paired.CostMeter(ProviderClient(), "private-test-key", ledger_path=ledger)


def test_post_usage_mismatch_charges_reserve_and_blocks_resume(tmp_path, monkeypatch):
    client = ProviderClient(
        response={
            "id": "generation-1",
            "model": paired.MERCURY_MODEL,
            "usage": {"prompt_tokens": 11, "completion_tokens": 2},
        }
    )
    meter, _request_log, ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.MeteringError, match="could not be reconciled"):
        meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert [call[0] for call in client.calls] == ["post", "get"]
    assert meter.calls[0]["conservative_charged_usd"] == paired.MERCURY_CALL_BOUND
    with pytest.raises(paired.MeteringError, match="did not reconcile cleanly"):
        paired.CostMeter(ProviderClient(), "private-test-key", ledger_path=ledger)


def test_missing_generation_id_is_charged_at_full_reserve_and_stops(tmp_path, monkeypatch):
    client = ProviderClient(response={"model": paired.MERCURY_MODEL, "usage": {}})
    meter, _request_log, _ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.MeteringError, match="could not be reconciled"):
        meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert [call[0] for call in client.calls] == ["post"]
    assert meter.calls[0]["cost_basis"] == "unreconciled-call-reserve"
    assert meter.calls[0]["conservative_charged_usd"] == paired.MERCURY_CALL_BOUND


def test_generation_token_reserve_violation_keeps_known_cost_but_charges_bound(tmp_path, monkeypatch):
    client = ProviderClient(
        generation={
            "data": {
                "id": "generation-1",
                "model": paired.MERCURY_MODEL,
                "total_cost": 0.000001,
                "tokens_prompt": paired.INPUT_TOKEN_RESERVE + 1,
                "tokens_completion": 1,
            }
        }
    )
    meter, _request_log, _ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.MeteringError, match="could not be reconciled"):
        meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert meter.calls[0]["generation_total_cost_usd"] == pytest.approx(0.000001)
    assert meter.calls[0]["conservative_charged_usd"] == paired.MERCURY_CALL_BOUND
    assert meter.calls[0]["http_attempts"] == 1
    assert meter.calls[0]["generation_lookup_attempts"] == 1


def test_actual_cost_above_per_call_bound_is_charged_and_stops(tmp_path, monkeypatch):
    client = ProviderClient(
        generation={
            "data": {
                "id": "generation-1",
                "model": paired.MERCURY_MODEL,
                "total_cost": paired.MERCURY_CALL_BOUND + 0.001,
                "tokens_prompt": 100,
                "tokens_completion": 2,
            }
        }
    )
    meter, _request_log, _ledger = make_meter(tmp_path, monkeypatch, client)

    with pytest.raises(paired.BudgetStop, match="exceeded its reserved per-call bound"):
        meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    assert meter.calls[0]["conservative_charged_usd"] == pytest.approx(paired.MERCURY_CALL_BOUND + 0.001)


def test_provider_inference_stays_blocked_while_reviewer_spend_is_unknown(tmp_path, monkeypatch):
    original = (paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH)
    with monkeypatch.context() as patch:
        patch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
        with pytest.raises(paired.MeteringError, match="Unreconciled reviewer spend"):
            paired.run_benchmark("pilot", count=1, output_dir=tmp_path)
    paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH = original
    assert list(tmp_path.iterdir()) == []


def test_one_run_authorization_charges_full_call_bound_without_generation_lookup(tmp_path, monkeypatch):
    request_log = tmp_path / "requests.jsonl"
    ledger = tmp_path / "spend-ledger.jsonl"
    monkeypatch.setattr(paired, "REQUEST_LOG_PATH", request_log)
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
    meter = paired.CostMeter(
        ProviderClient(),
        "private-test-key",
        base_spend_usd=0,
        prior_spend_usd=0,
        prior_attempts=[],
        ledger_path=ledger,
        test_only_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    meter.arm = "conventional"
    meter.reserve_pair("pilot:filter_select", "pilot")

    client = meter.client
    response = meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    entries = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert response["id"] == "generation-1"
    assert paired.REVIEW_SPEND_RECONCILED is False
    assert meter.incremental_cap_usd == 2.0
    assert meter.charged_usd == pytest.approx(paired.MERCURY_CALL_BOUND)
    assert [call[0] for call in client.calls] == ["post"]
    assert all(entry["test_only_authorization_id"] == paired.TEST_ONLY_AUTHORIZATION_ID for entry in entries)
    assert all(entry["incremental_cap_usd"] == 2.0 for entry in entries)


def test_spend_ledger_accepts_authorized_legacy_functional_records(tmp_path, monkeypatch):
    request_log = tmp_path / "requests.jsonl"
    ledger = tmp_path / "spend-ledger.jsonl"
    monkeypatch.setattr(paired, "REQUEST_LOG_PATH", request_log)
    meter = paired.CostMeter(
        ProviderClient(),
        "private-test-key",
        base_spend_usd=0,
        prior_spend_usd=0,
        prior_attempts=[],
        ledger_path=ledger,
        test_only_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    meter.arm = "conventional"
    meter.reserve_pair("pilot:filter_select", "pilot")
    meter.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})

    records = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert {record["event"]: record["provider_cost_mode"] for record in records} == {
        "attempt": paired.TEST_ONLY_FUNCTIONAL_COST_MODE,
        "settlement": paired.TEST_ONLY_FUNCTIONAL_COST_MODE,
    }
    current_spend, current_attempts = paired._load_spend_ledger(
        ledger,
        request_log,
        functional_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    assert current_spend == paired.MERCURY_CALL_BOUND
    assert len(current_attempts) == 1

    legacy_records = [
        {key: value for key, value in record.items() if key != "provider_cost_mode"} for record in records
    ]
    ledger.write_text("".join(json.dumps(record) + "\n" for record in legacy_records))
    legacy_spend, legacy_attempts = paired._load_spend_ledger(
        ledger,
        request_log,
        functional_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    assert legacy_spend == paired.MERCURY_CALL_BOUND
    assert len(legacy_attempts) == 1

    legacy_records[0]["test_only_authorization_id"] = "wrong-authorization"
    ledger.write_text("".join(json.dumps(record) + "\n" for record in legacy_records))
    with pytest.raises(paired.MeteringError, match="outside its one-run authorization"):
        paired._load_spend_ledger(
            ledger,
            request_log,
            functional_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
        )


def test_test_only_runner_passes_authorization_when_loading_legacy_ledger(tmp_path, monkeypatch):
    run_id = "0123456789abcdef0123456789abcdef"
    output_dir = tmp_path / f"{paired.TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    output_dir.mkdir()
    authorization = paired._test_only_authorization_record(run_id, output_dir)
    (output_dir / "authorization.json").write_text(json.dumps(authorization))
    (output_dir / "pairs.jsonl").write_text(
        json.dumps(
            {
                "pair_id": f"smoke:{paired.FAMILIES[0]}",
                "phase": "smoke",
                "family": paired.FAMILIES[0],
            }
        )
        + "\n"
    )
    (output_dir / "summary.json").write_text(
        json.dumps({"status": "SMOKE_FAILED", "smoke_gate": {"passed": False}})
    )
    (output_dir / "stop.jsonl").write_text("{}\n")
    monkeypatch.setattr(paired, "TEST_ONLY_OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "private-test-key")
    monkeypatch.setattr(paired, "SPEND_LEDGER_PATH", output_dir / "spend-ledger.jsonl")
    monkeypatch.setattr(paired, "_test_only_smoke_continuation_gate", lambda *_args: {"passed": True})
    authorization_ids = []

    def stop_after_ledger_load(_ledger_path, _request_path, *, functional_authorization_id=None):
        authorization_ids.append(functional_authorization_id)
        raise paired.MeteringError("test stop before provider calls")

    monkeypatch.setattr(paired, "_load_spend_ledger", stop_after_ledger_load)

    with pytest.raises(paired.MeteringError, match="test stop before provider calls"):
        paired._run_benchmark_locked(
            "pilot",
            paired.TEST_ONLY_MAX_PILOT_PAIRS,
            output_dir,
            authorization,
            continue_after_task_failures=True,
        )

    assert authorization_ids == [paired.TEST_ONLY_AUTHORIZATION_ID]


def test_one_run_authorization_reserves_pair_and_call_limits_before_provider_send(tmp_path, monkeypatch):
    client = ProviderClient()
    ledger = tmp_path / "spend-ledger.jsonl"
    request_log = tmp_path / "requests.jsonl"
    monkeypatch.setattr(paired, "REQUEST_LOG_PATH", request_log)
    monkeypatch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)

    near_cap = paired.CostMeter(
        client,
        "private-test-key",
        base_spend_usd=0,
        prior_spend_usd=paired.TEST_ONLY_INCREMENTAL_CAP_USD - paired.PAIR_BOUND / 2,
        prior_attempts=[],
        ledger_path=ledger,
        test_only_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    with pytest.raises(paired.BudgetStop, match="full pair cannot be reserved"):
        near_cap.reserve_pair("pilot:filter_select", "pilot")
    assert client.calls == []
    assert not ledger.exists()

    call_limited = paired.CostMeter(
        client,
        "private-test-key",
        base_spend_usd=0,
        prior_spend_usd=0,
        prior_attempts=[
            {
                "pair_id": "pilot:filter_select",
                "model_requested": paired.JEV_MODEL if index % 2 == 0 else paired.MERCURY_MODEL,
            }
            for index in range(paired.TEST_ONLY_MAX_CALLS_PER_PAIR)
        ],
        ledger_path=ledger,
        test_only_authorization_id=paired.TEST_ONLY_AUTHORIZATION_ID,
    )
    call_limited.arm = "conventional"
    call_limited.reserve_pair("pilot:filter_select", "pilot")
    with pytest.raises(paired.BudgetStop, match="provider-call ceiling"):
        call_limited.post_json(paired.CHAT_URL, "private-test-key", {"messages": []})
    assert client.calls == []
    assert not ledger.exists()


def test_one_run_authorization_cannot_run_main_phase(tmp_path, monkeypatch):
    original = (paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH)
    with monkeypatch.context() as patch:
        patch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
        with pytest.raises(paired.MeteringError, match="one-run authorization is invalid"):
            paired._run_benchmark_locked(
                "main",
                count=1,
                output_dir=tmp_path,
                test_only_authorization={
                    "authorization_id": paired.TEST_ONLY_AUTHORIZATION_ID,
                    "incremental_new_spend_cap_usd": paired.TEST_ONLY_INCREMENTAL_CAP_USD,
                    "max_pilot_pairs": paired.TEST_ONLY_MAX_PILOT_PAIRS,
                },
            )
    paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH = original
    assert list(tmp_path.iterdir()) == []


def test_one_run_authorization_is_bound_to_its_fresh_output_directory(tmp_path, monkeypatch):
    original = (paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH)
    run_id = "abcdef0123456789abcdef0123456789"
    expected_dir = paired.TEST_ONLY_OUTPUT_ROOT / f"{paired.TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    authorization = paired._test_only_authorization_record(run_id, expected_dir)
    with monkeypatch.context() as patch:
        patch.setattr(paired, "REVIEW_SPEND_RECONCILED", False)
        with pytest.raises(paired.MeteringError, match="one-run authorization is invalid"):
            paired._run_benchmark_locked("smoke", count=1, output_dir=tmp_path, test_only_authorization=authorization)
    paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH = original
    assert list(tmp_path.iterdir()) == []


def test_smoke_failure_summary_reports_actual_phase_and_keeps_history_unknown(tmp_path):
    run_id = "abcdef0123456789abcdef0123456789"
    output_dir = paired.TEST_ONLY_OUTPUT_ROOT / f"{paired.TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    authorization = paired._test_only_authorization_record(run_id, output_dir)
    summary = paired._smoke_failure_summary(
        authorization, output_dir, paired.MeteringError("local pre-send failure"), phase="smoke"
    )

    assert summary["phase"] == "smoke"
    assert summary["status"] == "STOPPED"
    assert summary["incremental_new_spend_upper_bound_usd"] == paired.TEST_ONLY_PRIOR_RESERVED_USD
    assert summary["historical_total_spend_usd"] is None
    assert summary["historical_total_reconciled"] is False


def test_main_phase_requires_accepted_pilot_before_any_output(tmp_path, monkeypatch):
    original = (paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH)
    with monkeypatch.context() as patch:
        patch.setattr(paired, "REVIEW_SPEND_RECONCILED", True)
        patch.setattr(paired, "SPEND_LEDGER_PATH", tmp_path / "spend-ledger.jsonl")
        patch.setenv("OPENROUTER_API_KEY", "private-test-key")
        with pytest.raises(paired.MeteringError, match="Pilot acceptance gate failed"):
            paired.run_benchmark("main", count=1, output_dir=tmp_path)
    paired.OUT_DIR, paired.RAW_PATH, paired.SUMMARY_PATH, paired.MANIFEST_PATH, paired.REQUEST_LOG_PATH = original
    assert {path.name for path in tmp_path.iterdir()} == {"spend-ledger.lock"}


def test_concurrent_benchmark_process_is_refused_before_work(tmp_path):
    lock = tmp_path / "spend-ledger.lock"

    with paired._exclusive_run_lock(lock):
        with pytest.raises(paired.MeteringError, match="Another benchmark process"):
            with paired._exclusive_run_lock(lock):
                pytest.fail("second benchmark acquired the spend lock")


def test_analysis_uses_jev_minus_baseline_and_reports_stale_recovery_fallbacks():
    records = [
        {
            "phase": "main",
            "pair_id": f"main:{index}",
            "family": family,
            "arms": {
                "jev": {
                    "complete": True,
                    "end_to_end_ms": 100,
                    "cost_usd": 0.1,
                    "fallback_used": True,
                    "stale_recoveries": 1,
                    "provider_calls": [],
                },
                "conventional": {
                    "complete": False,
                    "end_to_end_ms": 900,
                    "cost_usd": 0.2,
                    "provider_calls": [],
                },
            },
            "safety_violations": [],
        }
        for index, family in enumerate(("autocomplete_search", "filter_select"))
    ]

    summary = paired.analyze(records, "main")

    assert summary["completion_difference_jev_minus_conventional"]["completion_rate"] == pytest.approx(1.0)
    latency = summary["latency_difference_conventional_minus_jev"]
    assert latency["end_to_end_p50_ms_95pct_ci"]["low"] > 0
    assert summary["arms"]["jev"]["stale_recovery_fallbacks"] == 2
    assert not summary["gates"]["full_powered_sample"]
    assert summary["gates"]["status"] == "INCONCLUSIVE"


def test_pilot_gate_rejects_duplicate_or_missing_pair_ids():
    assert not paired._pilot_gate([])["ready_for_main"]


def test_pilot_gate_requires_all_families_complete_and_exact_provider_provenance():
    records = []
    for family in paired.FAMILIES:
        calls = []
        for arm, model_id in (("jev", paired.JEV_MODEL), ("conventional", paired.MERCURY_MODEL)):
            calls.append(
                {
                    "attempt_id": f"{family}-{arm}",
                    "arm": arm,
                    "kind": "selector",
                    "model_requested": model_id,
                    "model": model_id,
                    "generation_model": model_id,
                    "endpoint": (
                        "openrouter.ai/api/alpha/decisions"
                        if model_id == paired.JEV_MODEL
                        else "openrouter.ai/api/v1/chat/completions"
                    ),
                    "generation_id": f"generation-{family}-{arm}",
                    "generation_total_cost_usd": 0.00001,
                    "cost_basis": "openrouter-generation-total_cost",
                    "error": None,
                    "http_attempts": 1,
                    "generation_lookup_attempts": 1,
                    "tokens_prompt": 10,
                    "tokens_completion": 2,
                    "max_input_tokens_reserved": paired.INPUT_TOKEN_RESERVE,
                    "max_output_tokens_reserved": 0 if model_id == paired.JEV_MODEL else paired.MERCURY_OUTPUT_RESERVE,
                    "request_sha256": "a" * 64,
                    "request_bytes": 100,
                    "status": 200,
                    "conservative_charged_usd": 0.00001,
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2},
                }
            )
        records.append(
            {
                "phase": "pilot",
                "pair_id": f"pilot:{family}",
                "family": family,
                "complete_pair": True,
                "arms": {
                    "jev": {"complete": True, "errors": []},
                    "conventional": {"complete": True, "errors": []},
                },
                "provider_calls": calls,
                "provider_errors": [],
                "safety_violations": [],
            }
        )

    assert paired._pilot_gate(records)["ready_for_main"]
    records[-1]["provider_calls"][0]["generation_model"] = "unexpected/model"
    assert not paired._pilot_gate(records)["ready_for_main"]
