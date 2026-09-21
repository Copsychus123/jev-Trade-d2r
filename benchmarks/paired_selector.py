#!/usr/bin/env python3
"""Metered paired Jev-versus-conventional selector benchmark on loopback fixtures."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import html
import json
import math
import os
import random
import statistics
import sys
import threading
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jev_ultrafast import agent as agent_module  # noqa: E402
from jev_ultrafast import model as model_module  # noqa: E402
from jev_ultrafast.agent import Agent  # noqa: E402

PROTOCOL_PATH = ROOT / "benchmarks" / "paired_selector_protocol.json"
OUT_DIR = ROOT / "artifacts" / "paired-selector-benchmark"
RAW_PATH = OUT_DIR / "pairs.jsonl"
SUMMARY_PATH = OUT_DIR / "summary.json"
MANIFEST_PATH = OUT_DIR / "manifest.json"
REQUEST_LOG_PATH = OUT_DIR / "requests.jsonl"
SPEND_LEDGER_PATH = (
    Path.home() / "Library" / "Application Support" / "jev-ultrafast" / "paired-selector" / "spend-ledger.jsonl"
)
# Known cross-model reviewer charges are a lower bound; two timed-out reviews remain unpriced.
# Keep normal provider inference disabled until the complete external ledger is reconciled.
REVIEW_SPEND_USD = 7.931816
REVIEW_SPEND_RECONCILED = False
UNPRICED_REVIEW_TIMEOUTS = 2
STOP_USD = 24.0
ABSOLUTE_CAP_USD = 25.0
TEST_ONLY_INCREMENTAL_CAP_USD = 2.0
# The failed Jev smoke request had no generation ID; count its full ledger reserve
# against this same authorization before allowing the single corrected retry.
TEST_ONLY_PRIOR_RESERVED_USD = 0.000688128
TEST_ONLY_MAX_CALLS_PER_PAIR = 16
TEST_ONLY_AUTHORIZATION_ID = "pablo-functional-pilot:01a0b2d1-2554-7ce1-936b-49bf4561a8cb"
TEST_ONLY_FUNCTIONAL_COST_MODE = "functional-only-full-call-reserve-no-generation-metadata"
TEST_ONLY_OUTPUT_ROOT = ROOT / ".mvp"
TEST_ONLY_OUTPUT_PREFIX = "jev-functional-pilot-"
TEST_ONLY_SMOKE_RETRY_MARKER = TEST_ONLY_OUTPUT_ROOT / "jev-functional-smoke-retry-used.json"
LEGACY_REQUEST_MAX_BYTES = 8192
LEGACY_INPUT_TOKEN_RESERVE = 8192
REQUEST_MAX_BYTES = 16384
INPUT_TOKEN_RESERVE = 16384
MERCURY_OUTPUT_RESERVE = 128
JEV_CALL_BOUND = INPUT_TOKEN_RESERVE * 0.042 / 1_000_000
MERCURY_CALL_BOUND = (INPUT_TOKEN_RESERVE * 0.04 + MERCURY_OUTPUT_RESERVE * 0.15) / 1_000_000
PAIR_BOUND = 8 * JEV_CALL_BOUND + 16 * MERCURY_CALL_BOUND
MAIN_PAIRS = 2627
BOOTSTRAP_REPLICATES = 20_000
SEED = 20260919
FAMILIES = (
    "autocomplete_search",
    "filter_select",
    "long_page_navigation",
    "form_preview",
    "delayed_control",
)
TEST_ONLY_MAX_PILOT_PAIRS = len(FAMILIES)
TEST_ONLY_MAX_RUN_PAIRS = TEST_ONLY_MAX_PILOT_PAIRS + 1
TEST_ONLY_MAX_PROVIDER_CALLS = TEST_ONLY_MAX_RUN_PAIRS * TEST_ONLY_MAX_CALLS_PER_PAIR
TEST_ONLY_SMOKE_SEED = SEED + 50_000
TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID = "pilot:form_preview_recovery_1"
TEST_ONLY_FORM_PREVIEW_RECOVERY_SEED = SEED + 60_003
FAMILY_COUNTS = dict(zip(FAMILIES, (526, 526, 525, 525, 525), strict=True))
JEV_MODEL = "typesafe/jev-1.13"
MERCURY_MODEL = "inception/mercury-2.5"
CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
GENERATION_URL = "https://openrouter.ai/api/v1/generation"


def _call_bound(model_id: str, input_tokens: int) -> float:
    if model_id == JEV_MODEL:
        return input_tokens * 0.042 / 1_000_000
    if model_id == MERCURY_MODEL:
        return (input_tokens * 0.04 + MERCURY_OUTPUT_RESERVE * 0.15) / 1_000_000
    raise MeteringError(f"Unknown pinned model for cost bound: {model_id}")


def _supported_input_reserve(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value in (
        LEGACY_INPUT_TOKEN_RESERVE,
        INPUT_TOKEN_RESERVE,
    )


def _request_within_recorded_bounds(entry: dict, input_tokens: int) -> bool:
    if not _supported_input_reserve(input_tokens):
        return False
    expected_max_bytes = (
        LEGACY_REQUEST_MAX_BYTES if input_tokens == LEGACY_INPUT_TOKEN_RESERVE else REQUEST_MAX_BYTES
    )
    max_bytes = entry.get("request_max_bytes", expected_max_bytes)
    request_bytes = entry.get("request_bytes")
    return (
        max_bytes == expected_max_bytes
        and isinstance(request_bytes, int)
        and not isinstance(request_bytes, bool)
        and 0 < request_bytes <= max_bytes
    )


def _attempt_reserve_is_valid(entry: dict, model_id: str) -> bool:
    reserve = entry.get("reserved_usd")
    recorded_input_reserve = entry.get("max_input_tokens_reserved")
    input_reserves = (
        (recorded_input_reserve,)
        if recorded_input_reserve is not None
        else (LEGACY_INPUT_TOKEN_RESERVE, INPUT_TOKEN_RESERVE)
    )
    for input_tokens in input_reserves:
        if not _supported_input_reserve(input_tokens):
            continue
        if (
            isinstance(reserve, (int, float))
            and not isinstance(reserve, bool)
            and math.isfinite(reserve)
            and reserve == _call_bound(model_id, input_tokens)
            and _request_within_recorded_bounds(entry, input_tokens)
        ):
            return True
    return False
SELECTOR_SYSTEM = (
    "Choose the next browser operation from questions.operation.criteria. If that operation has a matching "
    "operation-specific target question, choose one target key from its criteria. Return only JSON with the exact "
    "keys operation and target; omit target when the operation has no target. Never invent an operation or target."
)


class BudgetStop(RuntimeError):
    """Raised before a request when its conservative reserve would cross the stop ceiling."""


class MeteringError(RuntimeError):
    """Raised before a request if its maximum possible cost cannot be bounded."""


def _one_hot(criteria: dict, selected: str) -> dict:
    return {
        "choice": selected,
        "confidence": 1.0,
        "probabilities": {str(key): float(str(key) == selected) for key in criteria},
    }


def _seeded_word(rng: random.Random, prefix: str) -> str:
    return f"{prefix}-{rng.randrange(1000, 9999)}"


def make_trial(family: str, seed: int) -> dict:
    """Return a synthetic task, fixture values, and a separately evaluated oracle."""
    rng = random.Random(seed)
    token = _seeded_word(rng, "R")
    decoys = [_seeded_word(rng, "X"), _seeded_word(rng, "Y")]
    if family == "autocomplete_search":
        return {
            "family": family,
            "seed": seed,
            "goal": f"Search the local catalog for {token}, choose its exact autocomplete suggestion, and submit it.",
            "expected": {"value": token},
            "html": _document(
                "Catalog search",
                '<label for="query">Catalog search</label><input id="query" type="search" aria-label="Catalog search">'
                '<div id="suggestions" role="listbox" aria-label="Suggestions"></div>'
                '<button id="submit">Search catalog</button>',
                """const input=document.querySelector('#query'), list=document.querySelector('#suggestions');
let chosen=''; input.addEventListener('input',()=>{ list.replaceChildren();
  for (const value of VALUES) { const item=document.createElement('button'); item.type='button';
    item.setAttribute('role','option'); item.textContent=value; item.addEventListener('click',()=>{
      chosen=value; input.value=value; list.replaceChildren(); }); list.append(item); }
}); document.querySelector('#submit').addEventListener('click',()=>{
  location.href='/complete?'+new URLSearchParams({family:'autocomplete_search',
    value:chosen||'unselected'}); });""".replace("VALUES", json.dumps([token, *decoys])),
            ),
        }
    if family == "filter_select":
        desired = rng.choice(("survey", "invoice", "budget", "permit"))
        options = [desired, *decoys]
        rng.shuffle(options)
        labels = "".join(
            f'<option value="{html.escape(value)}">{html.escape(value.title())}</option>' for value in options
        )
        return {
            "family": family,
            "seed": seed,
            "goal": f"Set the local record category to {desired.title()} and apply the filter.",
            "expected": {"value": desired},
            "html": _document(
                "Record filter",
                '<label for="category">Record category</label>'
                f'<select id="category" aria-label="Record category">{labels}</select>'
                '<button id="apply">Apply filter</button>',
                """document.querySelector('#apply').addEventListener('click',()=>{
  location.href='/complete?'+new URLSearchParams({family:'filter_select',
    value:document.querySelector('#category').value}); });""",
            ),
        }
    if family == "long_page_navigation":
        target = _seeded_word(rng, "report")
        return {
            "family": family,
            "seed": seed,
            "goal": f"Scroll through the local archive, then open the report named {target}.",
            "expected": {"value": target},
            "html": _document(
                "Local archive",
                '<p>Archive index</p><div style="height:900px">Older local records</div>'
                f'<a href="/complete?{urlencode({"family": family, "value": target})}">'
                f"Open report {html.escape(target)}</a>",
                "",
            ),
        }
    if family == "form_preview":
        title = f"Report {token}"
        record_type = rng.choice(("survey", "invoice", "budget", "permit"))
        options = [record_type, *decoys]
        rng.shuffle(options)
        labels = "".join(
            f'<option value="{html.escape(value)}">{html.escape(value.title())}</option>' for value in options
        )
        return {
            "family": family,
            "seed": seed,
            "goal": f"Create a local draft titled {title}, set its record type to {record_type}, then preview it.",
            "expected": {"title": title, "type": record_type},
            "html": _document(
                "Draft preview",
                '<label for="title">Draft title</label><input id="title" aria-label="Draft title">'
                f'<label for="type">Record type</label><select id="type" aria-label="Record type">{labels}</select>'
                '<button id="preview">Preview draft</button>',
                """document.querySelector('#preview').addEventListener('click',()=>{
  location.href='/complete?'+new URLSearchParams({family:'form_preview',title:document.querySelector('#title').value,
    type:document.querySelector('#type').value}); });""",
            ),
        }
    if family == "delayed_control":
        policy = _seeded_word(rng, "P")
        return {
            "family": family,
            "seed": seed,
            "goal": f"Review local policy {policy}, then continue after its control becomes available.",
            "expected": {"value": "approved", "policy": policy},
            "html": _document(
                "Delayed approval",
                f'<label><input id="confirm" type="checkbox"> I reviewed local policy {html.escape(policy)}</label>'
                f'<button id="continue" disabled>Continue {html.escape(policy)}</button>',
                """document.querySelector('#confirm').addEventListener('change',event=>{
  if(event.target.checked) setTimeout(()=>{document.querySelector('#continue').disabled=false;},1300); });
document.querySelector('#continue').addEventListener('click',()=>{
  location.href='/complete?'+new URLSearchParams({family:'delayed_control',
    value:'approved',policy:POLICY}); });""".replace("POLICY", json.dumps(policy)),
            ),
        }
    raise ValueError(f"Unknown fixture family: {family}")


def _document(title: str, content: str, script: str) -> str:
    return (
        "<!doctype html><html><head><meta charset=utf-8><title>"
        + html.escape(title)
        + "</title><style>body{font:18px system-ui;margin:32px}label,select,input,button{display:block;margin:16px 0}"
        "button{padding:10px 16px}a{display:inline-block;margin-top:12px}</style></head><body><main>"
        + content
        + "</main><script>"
        + script
        + "</script></body></html>"
    )


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass

    def _send(self, body: str, status: int = 200) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/fixture":
            try:
                family = query["family"][0]
                seed = int(query["seed"][0])
                trial = make_trial(family, seed)
            except (KeyError, ValueError, IndexError):
                return self._send("Not found", 404)
            return self._send(trial["html"])
        if parsed.path == "/complete":
            family = html.escape(query.get("family", [""])[0])
            value = html.escape(query.get("value", [""])[0])
            title = html.escape(query.get("title", [""])[0])
            record_type = html.escape(query.get("type", [""])[0])
            policy = html.escape(query.get("policy", [""])[0])
            return self._send(
                f'<main data-family="{family}"><h1>Task complete</h1>'
                f'<output id="receipt" data-value="{value}" data-title="{title}" '
                f'data-type="{record_type}" data-policy="{policy}">Saved</output></main>'
            )
        self._send("Not found", 404)


@contextmanager
def fixture_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _oracle(browser, trial: dict, fixture_origin: str) -> dict:
    observed = browser.evaluate(
        "(() => ({url:location.href, origin:location.origin, "
        "family:document.querySelector('main')?.dataset.family||'', "
        "value:document.querySelector('#receipt')?.dataset.value||'', "
        "title:document.querySelector('#receipt')?.dataset.title||'', "
        "type:document.querySelector('#receipt')?.dataset.type||'', "
        "policy:document.querySelector('#receipt')?.dataset.policy||''}))()"
    )
    expected = trial["expected"]
    exact = (
        observed["origin"] == fixture_origin
        and observed["family"] == trial["family"]
        and all(observed.get(key) == value for key, value in expected.items())
    )
    return {"passed": bool(exact), "observed": observed}


def _reported_cost(usage: dict, model: str) -> tuple[float | None, str]:
    for key in ("cost", "total_cost"):
        value = usage.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            return float(value), "provider_reported_cost"
    prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion = usage.get("completion_tokens", usage.get("output_tokens", 0))
    if isinstance(prompt, int) and prompt >= 0 and isinstance(completion, int) and completion >= 0:
        input_rate, output_rate = (0.042, 0.0) if "jev" in model else (0.04, 0.15)
        return (prompt * input_rate + completion * output_rate) / 1_000_000, "reported_tokens_at_verified_rates"
    return None, "conservative_request_upper_bound"


def _response_model_matches(expected: str, actual: object) -> bool:
    if actual == expected:
        return True
    if expected != JEV_MODEL or not isinstance(actual, str) or not actual.startswith(expected + "-"):
        return False
    suffix = actual[len(expected) + 1 :]
    return len(suffix) == 8 and suffix.isdigit()


def _response_token_count(usage: dict, *names: str) -> int | None:
    values = [usage[name] for name in names if name in usage]
    if not values:
        return None
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values):
        raise MeteringError("Inference response reported an invalid token count.")
    if len(set(values)) != 1:
        raise MeteringError("Inference response token-count aliases disagree.")
    return values[0]


def _load_spend_ledger(
    ledger_path: Path,
    request_log_path: Path,
    *,
    functional_authorization_id: str | None = None,
) -> tuple[float, list[dict]]:
    if request_log_path.exists() and request_log_path.stat().st_size and not ledger_path.exists():
        raise MeteringError("Existing request records have no durable spend ledger; manual reconciliation required.")
    if not ledger_path.exists():
        return 0.0, []

    attempts: dict[str, dict] = {}
    settlements: dict[str, dict] = {}
    for line_number, line in enumerate(ledger_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise MeteringError(f"Spend ledger line {line_number} is invalid JSON; inference blocked.") from error
        if not isinstance(entry, dict):
            raise MeteringError(f"Spend ledger line {line_number} is not an object; inference blocked.")
        attempt_id = entry.get("attempt_id")
        if not isinstance(attempt_id, str) or not attempt_id:
            raise MeteringError(f"Spend ledger line {line_number} has no attempt ID; inference blocked.")
        if entry.get("event") == "attempt":
            reserve = entry.get("reserved_usd")
            model_id = entry.get("model_requested")
            expected_endpoint = (
                "openrouter.ai/api/alpha/decisions"
                if model_id == JEV_MODEL
                else "openrouter.ai/api/v1/chat/completions"
            )
            if (
                attempt_id in attempts
                or isinstance(reserve, bool)
                or not isinstance(reserve, (int, float))
                or not math.isfinite(reserve)
                or not isinstance(model_id, str)
                or model_id not in {JEV_MODEL, MERCURY_MODEL}
                or not _attempt_reserve_is_valid(entry, model_id)
                or not isinstance(entry.get("pair_id"), str)
                or entry.get("endpoint") != expected_endpoint
                or not isinstance(entry.get("request_sha256"), str)
                or len(entry["request_sha256"]) != 64
            ):
                raise MeteringError(f"Spend ledger attempt {attempt_id} is invalid or duplicated; inference blocked.")
            attempts[attempt_id] = dict(entry)
        elif entry.get("event") == "settlement":
            if attempt_id in settlements or attempt_id not in attempts:
                raise MeteringError(
                    f"Spend ledger settlement {attempt_id} is orphaned or duplicated; inference blocked."
                )
            charged = entry.get("charged_usd")
            if (
                isinstance(charged, bool)
                or not isinstance(charged, (int, float))
                or not math.isfinite(charged)
                or charged < 0
            ):
                raise MeteringError(f"Spend ledger settlement {attempt_id} has invalid cost; inference blocked.")
            settlements[attempt_id] = dict(entry)
        else:
            raise MeteringError(f"Spend ledger line {line_number} has an unknown event; inference blocked.")

    total = 0.0
    loaded = []
    for attempt_id, attempt in attempts.items():
        settlement = settlements.get(attempt_id)
        if settlement is None:
            raise MeteringError(
                f"Provider attempt {attempt_id} is unsettled in the durable ledger; manual reconciliation required."
            )
        legacy_functional_mode = (
            settlement.get("provider_cost_mode") is None
            and settlement.get("cost_basis") == TEST_ONLY_FUNCTIONAL_COST_MODE
        )
        if settlement.get("provider_cost_mode") == TEST_ONLY_FUNCTIONAL_COST_MODE or legacy_functional_mode:
            if (
                functional_authorization_id != TEST_ONLY_AUTHORIZATION_ID
                or attempt.get("provider_cost_mode") not in (None, TEST_ONLY_FUNCTIONAL_COST_MODE)
                or attempt.get("test_only_authorization_id") != functional_authorization_id
                or settlement.get("provider_cost_mode") not in (None, TEST_ONLY_FUNCTIONAL_COST_MODE)
                or settlement.get("test_only_authorization_id") != functional_authorization_id
                or settlement.get("error") is not None
                or settlement.get("cost_basis") != TEST_ONLY_FUNCTIONAL_COST_MODE
                or not _response_model_matches(attempt["model_requested"], settlement.get("response_model"))
                or settlement.get("generation_model") is not None
                or settlement.get("generation_total_cost_usd") is not None
                or settlement.get("generation_lookup_attempts") != 0
                or settlement.get("charged_usd") != attempt["reserved_usd"]
            ):
                raise MeteringError(
                    f"Functional-only provider attempt {attempt_id} is outside its one-run authorization."
                )
            prompt_tokens = settlement.get("response_tokens_prompt")
            completion_tokens = settlement.get("response_tokens_completion")
            if (
                prompt_tokens is not None
                and (
                    isinstance(prompt_tokens, bool)
                    or not isinstance(prompt_tokens, int)
                    or not 0 <= prompt_tokens <= INPUT_TOKEN_RESERVE
                )
            ) or (
                completion_tokens is not None
                and (
                    isinstance(completion_tokens, bool)
                    or not isinstance(completion_tokens, int)
                    or completion_tokens < 0
                    or (
                        attempt["model_requested"] == MERCURY_MODEL
                        and completion_tokens > MERCURY_OUTPUT_RESERVE
                    )
                )
            ):
                raise MeteringError(f"Functional-only provider attempt {attempt_id} exceeded its token reserve.")
            attempt.update(settlement)
            total += float(settlement["charged_usd"])
            loaded.append(attempt)
            continue
        if settlement.get("error") or settlement.get("cost_basis") != "openrouter-generation-total_cost":
            raise MeteringError(
                f"Provider attempt {attempt_id} did not reconcile cleanly; manual review required before resuming."
            )
        if (
            settlement.get("generation_model") != attempt["model_requested"]
            or settlement.get("response_model") != attempt["model_requested"]
            or not isinstance(settlement.get("generation_id"), str)
            or not settlement["generation_id"]
            or settlement.get("charged_usd") != settlement.get("generation_total_cost_usd")
        ):
            raise MeteringError(
                f"Provider attempt {attempt_id} has inconsistent generation provenance; inference blocked."
            )
        prompt_tokens = settlement.get("tokens_prompt")
        completion_tokens = settlement.get("tokens_completion")
        if (
            isinstance(prompt_tokens, bool)
            or not isinstance(prompt_tokens, int)
            or not 0 <= prompt_tokens <= INPUT_TOKEN_RESERVE
            or isinstance(completion_tokens, bool)
            or not isinstance(completion_tokens, int)
            or completion_tokens < 0
            or (attempt["model_requested"] == MERCURY_MODEL and completion_tokens > MERCURY_OUTPUT_RESERVE)
        ):
            raise MeteringError(f"Provider attempt {attempt_id} usage is outside its reserve; inference blocked.")
        for response_key, generation_count in (
            ("response_tokens_prompt", prompt_tokens),
            ("response_tokens_completion", completion_tokens),
        ):
            reported_count = settlement.get(response_key)
            if reported_count is not None and (
                isinstance(reported_count, bool)
                or not isinstance(reported_count, int)
                or reported_count != generation_count
            ):
                raise MeteringError(f"Provider attempt {attempt_id} usage counts disagree; inference blocked.")
        if settlement["charged_usd"] > attempt["reserved_usd"]:
            raise MeteringError(
                f"Provider attempt {attempt_id} exceeded its reserved cost; manual review required before resuming."
            )
        attempt.update(settlement)
        total += float(settlement["charged_usd"])
        loaded.append(attempt)
    return total, loaded


class CostMeter:
    """One-attempt HTTP transport with pre-send size, token, and dollar reserves."""

    def __init__(
        self,
        client: httpx.Client,
        api_key: str,
        base_spend_usd: float = REVIEW_SPEND_USD,
        *,
        prior_spend_usd: float | None = None,
        prior_attempts: list[dict] | None = None,
        ledger_path: Path | None = None,
        test_only_authorization_id: str | None = None,
        functional_only_cost_mode: bool = False,
    ):
        if test_only_authorization_id not in (None, TEST_ONLY_AUTHORIZATION_ID):
            raise MeteringError("Unknown test-only authorization; provider inference is blocked.")
        if functional_only_cost_mode and test_only_authorization_id != TEST_ONLY_AUTHORIZATION_ID:
            raise MeteringError("Functional-only cost mode requires the one-run test authorization.")
        self.client = client
        self.api_key = api_key
        self.base_spend_usd = base_spend_usd
        self.test_only_authorization_id = test_only_authorization_id
        self.functional_only_cost_mode = functional_only_cost_mode or (
            test_only_authorization_id == TEST_ONLY_AUTHORIZATION_ID
        )
        self.incremental_cap_usd = TEST_ONLY_INCREMENTAL_CAP_USD if test_only_authorization_id else None
        self.ledger_path = ledger_path or REQUEST_LOG_PATH.with_name("spend-ledger.jsonl")
        if prior_spend_usd is None or prior_attempts is None:
            prior_spend_usd, prior_attempts = _load_spend_ledger(
                self.ledger_path,
                REQUEST_LOG_PATH,
                functional_authorization_id=(test_only_authorization_id if self.functional_only_cost_mode else None),
            )
        self.charged_usd = prior_spend_usd
        self.prior_attempts = prior_attempts
        self.calls: list[dict] = []
        self.arm = ""
        self.reserved_pair_id: str | None = None
        self.reserved_phase: str | None = None

    @property
    def cumulative_upper_usd(self) -> float:
        return self.base_spend_usd + self.charged_usd

    def reserve_pair(self, pair_id: str, phase: str = "test") -> None:
        if self.reserved_pair_id is not None:
            raise MeteringError("A paired-run reservation is already active.")
        if self.incremental_cap_usd is not None:
            if phase not in {"smoke", "pilot"} or self.charged_usd + PAIR_BOUND > self.incremental_cap_usd:
                raise BudgetStop("The full pair cannot be reserved under this run's $2 incremental cap.")
        elif self.cumulative_upper_usd + PAIR_BOUND > STOP_USD:
            raise BudgetStop("A full paired run cannot be reserved under the $24 operational stop.")
        self.reserved_pair_id = str(pair_id)
        self.reserved_phase = phase

    def release_pair(self, pair_id: str) -> None:
        if self.reserved_pair_id != str(pair_id):
            raise MeteringError("Paired-run reservation identity mismatch.")
        self.reserved_pair_id = None
        self.reserved_phase = None

    @staticmethod
    def _generation_cost(client: httpx.Client, generation_id: str, api_key: str) -> tuple[float, dict]:
        response = client.get(
            GENERATION_URL,
            params={"id": generation_id},
            headers={"Authorization": f"Bearer {api_key}"},
            follow_redirects=False,
        )
        if response.status_code != 200:
            raise MeteringError(f"Generation cost lookup returned HTTP {response.status_code}.")
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or data.get("id") != generation_id:
            raise MeteringError("Generation cost lookup did not match the inference response ID.")
        value = data.get("total_cost")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise MeteringError("Generation cost lookup did not return a finite total_cost.")
        return float(value), data

    def post_json(self, url: str, key: str, body: dict) -> dict:
        if not REVIEW_SPEND_RECONCILED and self.test_only_authorization_id is None:
            raise MeteringError("Unreconciled reviewer spend blocks all provider inference.")
        is_jev = self.arm == "jev" and url == model_module.OPENROUTER_DECISIONS_URL
        is_helper = url == CHAT_URL and isinstance(body.get("messages"), list)
        if self.arm == "conventional" and url == CHAT_URL and "questions" in body:
            kind, model_id, payload = "selector", MERCURY_MODEL, self._selector_request(body)
        elif is_helper:
            kind, model_id, payload = "helper", MERCURY_MODEL, dict(body)
            payload["model"] = MERCURY_MODEL
            payload["max_tokens"] = MERCURY_OUTPUT_RESERVE
            payload["usage"] = {"include": True}
            payload.setdefault("reasoning", {"enabled": False})
        elif is_jev:
            kind, model_id, payload = "selector", JEV_MODEL, dict(body)
        else:
            raise MeteringError(f"Unexpected provider route rejected before send: {url}")
        if self.reserved_pair_id is None:
            raise MeteringError("Provider requests require an active full-pair budget reservation.")
        pair_calls = [
            call for call in [*self.prior_attempts, *self.calls] if str(call.get("pair_id")) == self.reserved_pair_id
        ]
        jev_calls = sum(call.get("model_requested") == JEV_MODEL for call in pair_calls)
        mercury_calls = sum(call.get("model_requested") == MERCURY_MODEL for call in pair_calls)
        if (is_jev and jev_calls >= 8) or (not is_jev and mercury_calls >= 16):
            raise MeteringError("Per-pair model-call ceiling reached before send.")
        if self.test_only_authorization_id is not None and (
            len(pair_calls) >= TEST_ONLY_MAX_CALLS_PER_PAIR
            or len(self.prior_attempts) + len(self.calls) >= TEST_ONLY_MAX_PROVIDER_CALLS
        ):
            raise BudgetStop("The authorized pilot provider-call ceiling was reached before send.")
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > REQUEST_MAX_BYTES:
            raise MeteringError(f"Request size {len(encoded)} exceeds the predeclared {REQUEST_MAX_BYTES}-byte bound.")
        call_bound = _call_bound(model_id, INPUT_TOKEN_RESERVE)
        if self.incremental_cap_usd is not None:
            if self.charged_usd + call_bound > self.incremental_cap_usd:
                raise BudgetStop("This request's reserve would cross the authorized $2 incremental cap.")
        elif self.cumulative_upper_usd + call_bound > STOP_USD:
            raise BudgetStop("This request's conservative reserve would cross the $24 operational stop.")
        attempt_id = uuid.uuid4().hex
        intent = {
            "event": "attempt",
            "attempt_id": attempt_id,
            "phase": self.reserved_phase,
            "pair_id": self.reserved_pair_id,
            "arm": self.arm,
            "kind": kind,
            "model_requested": model_id,
            "endpoint": "openrouter.ai/api/alpha/decisions" if is_jev else "openrouter.ai/api/v1/chat/completions",
            "request_bytes": len(encoded),
            "request_max_bytes": REQUEST_MAX_BYTES,
            "max_input_tokens_reserved": INPUT_TOKEN_RESERVE,
            "max_output_tokens_reserved": 0 if is_jev else MERCURY_OUTPUT_RESERVE,
            "request_sha256": hashlib.sha256(encoded).hexdigest(),
            "reserved_usd": call_bound,
            "created_at_unix_ns": time.time_ns(),
        }
        if self.test_only_authorization_id is not None:
            intent["test_only_authorization_id"] = self.test_only_authorization_id
            intent["provider_cost_mode"] = TEST_ONLY_FUNCTIONAL_COST_MODE
            intent["incremental_cap_usd"] = self.incremental_cap_usd
            intent["prior_reserved_usd"] = TEST_ONLY_PRIOR_RESERVED_USD
        _append_record(self.ledger_path, intent)
        self.charged_usd += call_bound
        started = time.perf_counter()
        status = None
        response_data: dict = {}
        error = None
        try:
            response = self.client.post(
                url if is_jev else CHAT_URL,
                content=encoded,
                headers={
                    "Authorization": f"Bearer {key or self.api_key}",
                    "Content-Type": "application/json",
                },
                follow_redirects=False,
            )
            status = response.status_code
            try:
                parsed = response.json()
                if isinstance(parsed, dict):
                    response_data = parsed
            except ValueError:
                parsed = None
            if not 200 <= response.status_code < 300:
                error = f"HTTP {response.status_code}"
            elif not isinstance(parsed, dict):
                error = "invalid JSON response"
        except httpx.HTTPError as exc:
            error = type(exc).__name__
            response = None
            parsed = None
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        if self.test_only_authorization_id is not None and response is not None:
            response_content = getattr(response, "content", None)
            raw_body_exact = isinstance(response_content, (bytes, bytearray, memoryview))
            if raw_body_exact:
                response_bytes = bytes(response_content)
            else:
                response_bytes = json.dumps(response_data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            try:
                _append_record(
                    REQUEST_LOG_PATH.with_name("model-evidence.jsonl"),
                    {
                        "schema_version": "jev-test-only-model-evidence.v1",
                        "test_only_authorization_id": self.test_only_authorization_id,
                        "attempt_id": attempt_id,
                        "phase": self.reserved_phase,
                        "pair_id": self.reserved_pair_id,
                        "arm": self.arm,
                        "kind": kind,
                        "model_requested": model_id,
                        "response_model": response_data.get("model"),
                        "http_status": status,
                        "request_sha256": hashlib.sha256(encoded).hexdigest(),
                        "request_bytes": len(encoded),
                        "request_max_bytes": REQUEST_MAX_BYTES,
                        "offered_choices": body.get("questions") if kind == "selector" else None,
                        "raw_body_exact": raw_body_exact,
                        "raw_body_base64": base64.b64encode(response_bytes).decode("ascii"),
                    },
                )
            except OSError:
                error = error or "response evidence could not be durably saved"
        usage = response_data.get("usage", {}) if isinstance(response_data.get("usage", {}), dict) else {}
        generation_id = response_data.get("id") if isinstance(response_data, dict) else None
        generation = None
        generation_error = None
        generation_attempts = 0
        observed_cost = None
        response_cost = None
        response_cost_basis = None
        if not error and self.functional_only_cost_mode:
            response_model = response_data.get("model")
            if not _response_model_matches(model_id, response_model):
                error = "response model mismatch"
            else:
                try:
                    prompt_tokens = _response_token_count(usage, "prompt_tokens", "input_tokens")
                    completion_tokens = _response_token_count(usage, "completion_tokens", "output_tokens")
                except MeteringError as exc:
                    error = str(exc)
                if error is None and prompt_tokens is not None and prompt_tokens > INPUT_TOKEN_RESERVE:
                    error = "response prompt-token count exceeded its reserve"
                elif (
                    error is None
                    and completion_tokens is not None
                    and model_id == MERCURY_MODEL
                    and completion_tokens > MERCURY_OUTPUT_RESERVE
                ):
                    error = "response completion-token count exceeded its reserve"
                if error is None:
                    response_cost, response_cost_basis = _reported_cost(usage, model_id)
                    if response_cost is not None and response_cost > call_bound:
                        error = "response-reported cost exceeded its reserved per-call bound"
        elif not error:
            try:
                if not isinstance(generation_id, str) or not generation_id:
                    raise MeteringError("Inference response omitted its OpenRouter generation ID.")
                generation_attempts = 1
                observed_cost, generation = self._generation_cost(self.client, generation_id, key or self.api_key)
                if generation.get("model") != model_id:
                    raise MeteringError("Generation metadata did not match the pinned model ID.")
                prompt_tokens = generation.get("tokens_prompt")
                completion_tokens = generation.get("tokens_completion")
                if (
                    isinstance(prompt_tokens, bool)
                    or not isinstance(prompt_tokens, int)
                    or not 0 <= prompt_tokens <= INPUT_TOKEN_RESERVE
                ):
                    raise MeteringError("Generation prompt-token count exceeded or omitted its reserve.")
                if (
                    isinstance(completion_tokens, bool)
                    or not isinstance(completion_tokens, int)
                    or completion_tokens < 0
                    or (model_id == MERCURY_MODEL and completion_tokens > MERCURY_OUTPUT_RESERVE)
                ):
                    raise MeteringError("Generation completion-token count was invalid or exceeded its reserve.")
                for response_key, generation_count in (
                    ("prompt_tokens", prompt_tokens),
                    ("input_tokens", prompt_tokens),
                    ("completion_tokens", completion_tokens),
                    ("output_tokens", completion_tokens),
                ):
                    reported_count = usage.get(response_key)
                    if reported_count is not None and (
                        isinstance(reported_count, bool)
                        or not isinstance(reported_count, int)
                        or reported_count != generation_count
                    ):
                        raise MeteringError("Inference usage did not match its generation record.")
            except (httpx.HTTPError, ValueError, MeteringError) as exc:
                generation_error = f"cost reconciliation failed ({type(exc).__name__})"
        else:
            observed_cost = None
        if not error and generation is not None and response_data.get("model") != model_id:
            generation_error = "cost reconciliation failed (response model mismatch)"
        charged = (
            call_bound
            if self.functional_only_cost_mode
            else observed_cost
            if observed_cost is not None and generation_error is None
            else max(call_bound, observed_cost or 0.0)
        )
        if generation_error and not self.functional_only_cost_mode:
            error = generation_error
        cost_basis = (
            TEST_ONLY_FUNCTIONAL_COST_MODE
            if self.functional_only_cost_mode
            else "openrouter-generation-total_cost"
            if observed_cost is not None and generation_error is None
            else "unreconciled-call-reserve"
        )
        self.charged_usd += charged - call_bound
        call_record = {
            "attempt_id": attempt_id,
            "phase": self.reserved_phase,
            "pair_id": self.reserved_pair_id,
            "arm": self.arm,
            "kind": kind,
            "model_requested": model_id,
            "model": response_data.get("model", model_id),
            "endpoint": "openrouter.ai/api/alpha/decisions" if is_jev else "openrouter.ai/api/v1/chat/completions",
            "request_bytes": len(encoded),
            "request_max_bytes": REQUEST_MAX_BYTES,
            "request_sha256": hashlib.sha256(encoded).hexdigest(),
            "max_input_tokens_reserved": INPUT_TOKEN_RESERVE,
            "max_output_tokens_reserved": 0 if is_jev else MERCURY_OUTPUT_RESERVE,
            "http_attempts": 1,
            "status": status,
            "generation_id": generation_id,
            "generation_total_cost_usd": observed_cost,
            "generation_model": generation.get("model") if isinstance(generation, dict) else None,
            "generation_usage": generation,
            "tokens_prompt": generation.get("tokens_prompt") if isinstance(generation, dict) else None,
            "tokens_completion": generation.get("tokens_completion") if isinstance(generation, dict) else None,
            "generation_lookup_attempts": generation_attempts,
            "usage": usage,
            "latency_ms": elapsed_ms,
            "observed_cost_usd": observed_cost,
            "response_cost_usd": response_cost,
            "response_cost_basis": response_cost_basis,
            "generation_cost_reconciled": bool(generation is not None and generation_error is None),
            "cost_basis": cost_basis,
            "conservative_charged_usd": round(charged, 12),
            "error": error,
        }
        if self.test_only_authorization_id is not None:
            call_record["test_only_authorization_id"] = self.test_only_authorization_id
            call_record["incremental_cap_usd"] = self.incremental_cap_usd
            call_record["prior_reserved_usd"] = TEST_ONLY_PRIOR_RESERVED_USD
        _append_record(
            self.ledger_path,
            {
                "event": "settlement",
                "attempt_id": attempt_id,
                "charged_usd": charged,
                "generation_id": generation_id,
                "response_model": response_data.get("model"),
                "generation_model": generation.get("model") if isinstance(generation, dict) else None,
                "generation_total_cost_usd": observed_cost,
                "tokens_prompt": generation.get("tokens_prompt") if isinstance(generation, dict) else None,
                "tokens_completion": generation.get("tokens_completion") if isinstance(generation, dict) else None,
                "response_tokens_prompt": usage.get("prompt_tokens", usage.get("input_tokens")),
                "response_tokens_completion": usage.get("completion_tokens", usage.get("output_tokens")),
                "response_cost_usd": response_cost,
                "generation_lookup_attempts": generation_attempts,
                "cost_basis": cost_basis,
                "error": error,
                **(
                    {
                        "test_only_authorization_id": self.test_only_authorization_id,
                        "provider_cost_mode": TEST_ONLY_FUNCTIONAL_COST_MODE,
                        "incremental_cap_usd": self.incremental_cap_usd,
                    }
                    if self.test_only_authorization_id is not None
                    else {}
                ),
            },
        )
        self.calls.append(call_record)
        _append_record(REQUEST_LOG_PATH, call_record)
        if self.incremental_cap_usd is not None and self.charged_usd > self.incremental_cap_usd:
            raise BudgetStop("Provider-reported incremental cost crossed $2; no further calls will be made.")
        if self.incremental_cap_usd is None and self.cumulative_upper_usd > STOP_USD:
            raise BudgetStop("Provider-reported cost crossed the $24 operational stop; no further calls will be made.")
        if not self.functional_only_cost_mode and observed_cost is not None and observed_cost > call_bound:
            raise BudgetStop(
                "Reconciled request cost exceeded its reserved per-call bound; no more calls will be sent."
            )
        if error:
            raise MeteringError(f"Metered provider call could not be reconciled ({error}); retries are disabled.")
        if not is_jev and kind == "selector":
            return self._selector_envelope(payload, parsed)
        return parsed

    @staticmethod
    def _selector_request(body: dict) -> dict:
        return {
            "model": MERCURY_MODEL,
            "max_tokens": MERCURY_OUTPUT_RESERVE,
            "response_format": {"type": "json_object"},
            "reasoning": {"enabled": False},
            "usage": {"include": True},
            "messages": [
                {"role": "system", "content": SELECTOR_SYSTEM},
                {"role": "user", "content": json.dumps(body, ensure_ascii=False, separators=(",", ":"))},
            ],
        }

    @staticmethod
    def _selector_envelope(payload: dict, response: dict) -> dict:
        try:
            answer = json.loads(response["choices"][0]["message"]["content"])
            questions = json.loads(payload["messages"][1]["content"])["questions"]
            operation = answer["operation"]
            operation_criteria = questions["operation"]["criteria"]
            if set(answer) - {"operation", "target"} or operation not in operation_criteria:
                raise ValueError()
            result = {"operation": _one_hot(operation_criteria, operation)}
            target_key = operation.lower() + "_target"
            if target_key in questions:
                target = answer["target"]
                target_criteria = questions[target_key]["criteria"]
                if target not in target_criteria:
                    raise ValueError()
                result[target_key] = _one_hot(target_criteria, target)
            elif answer.get("target") not in (None, ""):
                raise ValueError()
            return {"model": MERCURY_MODEL, "usage": response.get("usage", {}), "answers": result}
        except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            raise ValueError("Mercury returned an invalid or illegal operation/target; no action executed.") from None


def _provider_for(meter: CostMeter, arm: str):
    meter.arm = arm
    if arm == "jev":
        return model_module.OPENROUTER_DECISIONS_URL, meter.api_key, JEV_MODEL
    return CHAT_URL, meter.api_key, MERCURY_MODEL


def run_arm(origin: str, trial: dict, arm: str, meter: CostMeter) -> dict:
    meter.arm = arm
    start = time.perf_counter()
    trial_url = f"{origin}/fixture?{urlencode({'family': trial['family'], 'seed': trial['seed']})}"
    record = {"arm": arm, "family": trial["family"], "seed": trial["seed"], "goal": trial["goal"]}
    agent = None
    old_provider = model_module.decision_provider
    old_post = model_module.post_json
    old_steps = agent_module.MAX_STEPS
    prior_calls = len(meter.calls)
    try:
        model_module.decision_provider = lambda: _provider_for(meter, arm)
        model_module.post_json = meter.post_json
        agent_module.MAX_STEPS = 4
        env = {
            "TEXT_MODEL_API_KEY": meter.api_key,
            "TEXT_MODEL_BASE_URL": "https://openrouter.ai/api/v1",
            "TEXT_MODEL": MERCURY_MODEL,
            "TEXT_MODEL_REASONING": "none",
        }
        with _temporary_environment(env):
            agent = Agent(trial_url, trial["goal"])
            for _state in agent.run():
                pass
            oracle = _oracle(agent.browser, trial, origin)
            elapsed_ms = round((time.perf_counter() - start) * 1000)
            state = agent.state
        history = state.get("history", [])
        safety = []
        if oracle["observed"].get("origin") != origin:
            safety.append("browser left loopback fixture origin")
        allowed_kinds = {"click", "fill", "select", "scroll", "wait"}
        for row in history:
            if row.get("execution_status") == "executed" and row.get("kind") not in allowed_kinds:
                safety.append("executor recorded an unsupported action kind")
        calls = meter.calls[prior_calls:]
        if meter.incremental_cap_usd is not None and meter.charged_usd > meter.incremental_cap_usd:
            raise BudgetStop("The authorized pilot's incremental spend cap was crossed.")
        if meter.incremental_cap_usd is None and meter.cumulative_upper_usd > STOP_USD:
            raise BudgetStop("The provider response crossed the $24 operational stop; no next call is allowed.")
        if not any(call.get("kind") == "selector" for call in calls):
            diagnostics = [
                f"{item.get('phase')}:{item.get('type')}:{str(item.get('message', ''))[:240]}"
                for item in state.get("errors", [])
            ]
            raise MeteringError(
                "Arm produced no selector call "
                f"(status={state.get('status')}, decisions={len(state.get('decisions', []))}, "
                f"actions={len(history)}, errors={diagnostics}); no next arm is allowed."
            )
        valid_provider_call = _provider_call_budgeted if meter.functional_only_cost_mode else _provider_call_reconciled
        if any(not valid_provider_call(call) for call in calls):
            raise MeteringError("Arm produced a provider call outside its accounting gate; no next arm is allowed.")
        selector_calls = [call for call in calls if call.get("kind") == "selector"]
        model_responses_valid = bool(selector_calls) and all(
            valid_provider_call(call) and call.get("error") is None for call in selector_calls
        ) and not state.get("errors", [])
        record.update(
            {
                "status": state.get("status"),
                "complete": bool(oracle["passed"]),
                "action_outcome_passed": bool(oracle["passed"]),
                "loopback_origin_preserved": oracle["observed"].get("origin") == origin,
                "navigation_succeeded": (
                    bool(oracle["passed"]) if trial["family"] == "long_page_navigation" else None
                ),
                "model_responses_valid": model_responses_valid,
                "generation_cost_reconciled": all(
                    call.get("generation_cost_reconciled") is True for call in calls
                ),
                "functional_only_accounting": meter.functional_only_cost_mode,
                "oracle": oracle,
                "safety_violations": safety,
                "end_to_end_ms": elapsed_ms,
                "agent_loop_ms": state.get("elapsed_ms", 0),
                "decision_count": len(state.get("decisions", [])),
                "action_count": len(history),
                "action_outcomes": [
                    {
                        "kind": row.get("kind"),
                        "execution_status": row.get("execution_status"),
                        "succeeded": row.get("execution_status") == "executed",
                    }
                    for row in history
                ],
                "helper_count": len(state.get("text_calls", [])),
                "stale_recoveries": state.get("stale_recoveries", 0),
                "fallback_used": bool(state.get("fallback_used")),
                "provider_retry_count": sum(max(0, int(call.get("http_attempts", 1)) - 1) for call in calls),
                "decision_latency_ms": [call["latency_ms"] for call in calls if call["kind"] == "selector"],
                "helper_latency_ms": [call["latency_ms"] for call in calls if call["kind"] == "helper"],
                "provider_calls": calls,
                "errors": list(state.get("errors", [])),
                "final_url": state.get("page", {}).get("url"),
            }
        )
    except (BudgetStop, MeteringError):
        raise
    except Exception as error:
        record.update(
            {
                "status": "error",
                "complete": False,
                "action_outcome_passed": False,
                "navigation_succeeded": False,
                "loopback_origin_preserved": False,
                "model_responses_valid": False,
                "oracle": {"passed": False, "observed": None},
                "safety_violations": [],
                "end_to_end_ms": round((time.perf_counter() - start) * 1000),
                "agent_loop_ms": 0,
                "decision_count": 0,
                "action_count": 0,
                "helper_count": 0,
                "stale_recoveries": 0,
                "fallback_used": False,
                "provider_retry_count": 0,
                "decision_latency_ms": [],
                "helper_latency_ms": [],
                "provider_calls": meter.calls[prior_calls:],
                "errors": [{"type": type(error).__name__, "message": str(error)}],
                "final_url": None,
            }
        )
    finally:
        model_module.decision_provider = old_provider
        model_module.post_json = old_post
        agent_module.MAX_STEPS = old_steps
        if agent is not None:
            agent.close()
    record["cost_usd"] = round(sum(call["conservative_charged_usd"] for call in record["provider_calls"]), 12)
    return record


@contextmanager
def _temporary_environment(values: dict[str, str]):
    missing = object()
    prior = {key: os.environ.get(key, missing) for key in values}
    try:
        os.environ.update(values)
        yield
    finally:
        for key, value in prior.items():
            if value is missing:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _append_record(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


@contextmanager
def _exclusive_run_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise MeteringError("Another benchmark process holds the spend-ledger lock; no calls were sent.") from error
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _read_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _source_manifest() -> dict:
    paths = (
        Path("jev_ultrafast/agent.py"),
        Path("jev_ultrafast/browser.py"),
        Path("jev_ultrafast/model.py"),
        Path("jev_ultrafast/snapshot.js"),
        Path("benchmarks/paired_selector.py"),
        Path("benchmarks/paired_selector_protocol.json"),
    )
    return {str(path): hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in paths}


def _git_metadata() -> dict:
    import subprocess

    def run(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()

    tracked = subprocess.run(
        ["git", "diff", "--name-only", "-z", "HEAD"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    dirty_file_sha256 = {}
    for raw_path in set(tracked.split(b"\0") + untracked.split(b"\0")) - {b""}:
        relative = Path(raw_path.decode("utf-8"))
        path = ROOT / relative
        if path.is_file() and not path.is_symlink():
            dirty_file_sha256[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()

    return {
        "head": run("rev-parse", "HEAD"),
        "branch": run("branch", "--show-current"),
        "dirty_paths": run("status", "--short"),
        "dirty_file_sha256": dirty_file_sha256,
    }


def _test_only_authorization_record(run_id: str, output_dir: Path, *, include_pilot: bool = True) -> dict:
    max_pilot_pairs = TEST_ONLY_MAX_PILOT_PAIRS if include_pilot else 0
    max_run_pairs = max_pilot_pairs + 1
    return {
        "schema_version": "jev-test-only-authorization.v1",
        "authorization_id": TEST_ONLY_AUTHORIZATION_ID,
        "authorized_by": "Pablo",
        "authorization_source_thread_id": "01a0b2d1-2554-7ce1-936b-49bf4561a8cb",
        "run_id": run_id,
        "output_dir": str(output_dir),
        "scope": (
            "One local-fixture smoke pair, followed only on success by the five-pair pilot."
            if include_pilot
            else "One local-fixture smoke pair only; no pilot pairs."
        ),
        "executor": "Repository Browser Harness/CDP for both Jev and conventional arms.",
        "models_in_scope": [JEV_MODEL, MERCURY_MODEL],
        "max_pilot_pairs": max_pilot_pairs,
        "max_run_pairs_including_smoke": max_run_pairs,
        "max_provider_calls_per_pair": TEST_ONLY_MAX_CALLS_PER_PAIR,
        "max_provider_calls_total": max_run_pairs * TEST_ONLY_MAX_CALLS_PER_PAIR,
        "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
        "prior_reserved_usd": TEST_ONLY_PRIOR_RESERVED_USD,
        "full_smoke_plus_pilot_rate_bound_usd": round(
            TEST_ONLY_PRIOR_RESERVED_USD + max_run_pairs * PAIR_BOUND, 12
        ),
        "historical_known_reviewer_spend_lower_bound_usd": REVIEW_SPEND_USD,
        "historical_unpriced_review_timeout_count": UNPRICED_REVIEW_TIMEOUTS,
        "historical_total_spend_usd": None,
        "historical_total_reconciled": False,
        "original_total_cap_usd": ABSOLUTE_CAP_USD,
        "original_total_cap_compliance_confirmed": False,
        "issued_at_unix_ns": time.time_ns(),
    }


def _recordable_task_outcome(arm: dict) -> bool:
    """Return true only for completed tasks or bounded, safe agent-level failures."""
    if not isinstance(arm, dict) or arm.get("loopback_origin_preserved") is not True:
        return False
    if arm.get("safety_violations"):
        return False
    calls = arm.get("provider_calls")
    if (
        not isinstance(calls, list)
        or not calls
        or arm.get("arm") not in {"jev", "conventional"}
        or any(not isinstance(call, dict) or call.get("arm") != arm.get("arm") for call in calls)
        or not any(call.get("kind") == "selector" for call in calls)
        or any(not _provider_call_budgeted(call) or call.get("error") is not None for call in calls)
    ):
        return False
    if arm.get("complete") is True:
        return not arm.get("errors") and arm.get("oracle", {}).get("passed") is True
    if arm.get("status") != "blocked" or arm.get("oracle", {}).get("passed") is not False:
        return False
    errors = arm.get("errors") or []
    allowed_phases = {"decision", "text_helper", "action_budget", "decision_budget"}
    return isinstance(errors, list) and all(
        error.get("phase") in allowed_phases and error.get("type") in {"ValueError", "RuntimeError"}
        for error in errors
        if isinstance(error, dict)
    ) and all(isinstance(error, dict) for error in errors)


def _test_only_smoke_continuation_gate(pair: dict, stop_rows: list[dict], summary: dict) -> dict:
    arms = pair.get("arms", {}) if isinstance(pair, dict) else {}
    calls = pair.get("provider_calls", []) if isinstance(pair, dict) else []
    expected_stop = [{"after_pair": f"smoke:{FAMILIES[0]}", "reason": "fixture/oracle or arm failure"}]
    all_arm_outcomes_recordable = (
        isinstance(arms, dict)
        and set(arms) == {"jev", "conventional"}
        and all(_recordable_task_outcome(arm) for arm in arms.values())
    )
    failed_arms = [arm for arm in arms.values() if arm.get("complete") is not True] if isinstance(arms, dict) else []
    arm_call_ids = []
    arm_calls_valid = isinstance(arms, dict)
    if arm_calls_valid:
        for arm in arms.values():
            arm_calls = arm.get("provider_calls") if isinstance(arm, dict) else None
            if not isinstance(arm_calls, list) or any(not isinstance(call, dict) for call in arm_calls):
                arm_calls_valid = False
                continue
            arm_call_ids.extend(call.get("attempt_id") for call in arm_calls)
    pair_call_ids = [call.get("attempt_id") for call in calls if isinstance(call, dict)]
    pair_is_original_smoke = (
        isinstance(pair, dict)
        and pair.get("phase") == "smoke"
        and pair.get("pair_id") == f"smoke:{FAMILIES[0]}"
        and pair.get("family") == FAMILIES[0]
        and pair.get("complete_pair") is True
        and pair.get("stop_reason") == "fixture/oracle or arm failure"
        and not pair.get("provider_errors")
        and not pair.get("safety_violations")
    )
    calls_valid = (
        isinstance(calls, list)
        and 0 < len(calls) <= TEST_ONLY_MAX_CALLS_PER_PAIR
        and all(isinstance(call, dict) for call in calls)
        and all(_provider_call_budgeted(call) and call.get("error") is None for call in calls)
        and arm_calls_valid
        and len(pair_call_ids) == len(arm_call_ids)
        and len(pair_call_ids) == len(set(pair_call_ids))
        and set(pair_call_ids) == set(arm_call_ids)
    )
    failed_outcomes_are_decision_or_task_failures = bool(failed_arms) and all(
        isinstance(arm, dict) and arm.get("status") == "blocked" and _recordable_task_outcome(arm)
        for arm in failed_arms
    )
    passed = (
        pair_is_original_smoke
        and all_arm_outcomes_recordable
        and failed_outcomes_are_decision_or_task_failures
        and calls_valid
        and stop_rows == expected_stop
        and isinstance(summary, dict)
        and summary.get("status") == "SMOKE_FAILED"
        and summary.get("smoke_gate", {}).get("passed") is False
    )
    return {
        "passed": passed,
        "reason": (
            "Only a bounded task/decision failure is present; both arms ran safely on loopback."
            if passed
            else "Smoke artifacts do not match the narrowly authorized task-failure continuation contract."
        ),
        "smoke_pair_id": f"smoke:{FAMILIES[0]}",
        "failed_arm_count": len(failed_arms),
        "provider_call_count": len(calls) if isinstance(calls, list) else 0,
        "raw_model_response_saved": False,
    }


def _pilot_attempt_integrity_gate(
    records: list[dict], *, incremental_upper_spend_usd: float | None, provider_calls_total: int
) -> dict:
    pilot = [record for record in records if record.get("phase") == "pilot"]
    ids = [record.get("pair_id") for record in pilot]
    families = [record.get("family") for record in pilot]
    pair_ids_valid = all(
        record.get("pair_id") == f"pilot:{record.get('family')}"
        or (
            record.get("family") == "form_preview"
            and record.get("pair_id") == "pilot:form_preview_recovery_1"
        )
        for record in pilot
    )
    sample_valid = (
        len(pilot) == TEST_ONLY_MAX_PILOT_PAIRS
        and len(set(ids)) == len(ids)
        and len(set(families)) == len(families)
        and set(families) == set(FAMILIES)
        and pair_ids_valid
    )
    pair_outcomes_valid = bool(pilot) and all(
        record.get("complete_pair") is True
        and set(record.get("arms", {})) == {"jev", "conventional"}
        and all(_recordable_task_outcome(arm) for arm in record["arms"].values())
        and not record.get("provider_errors")
        and not record.get("safety_violations")
        and all(_provider_call_budgeted(call) for call in record.get("provider_calls", []))
        and len(record.get("provider_calls", [])) <= TEST_ONLY_MAX_CALLS_PER_PAIR
        for record in pilot
    )
    spend_valid = (
        incremental_upper_spend_usd is not None
        and math.isfinite(incremental_upper_spend_usd)
        and incremental_upper_spend_usd <= TEST_ONLY_INCREMENTAL_CAP_USD
    )
    calls_valid = 0 < provider_calls_total <= TEST_ONLY_MAX_PROVIDER_CALLS
    return {
        "passed": sample_valid and pair_outcomes_valid and spend_valid and calls_valid,
        "five_unique_family_pairs": sample_valid,
        "both_arms_recorded_with_safe_task_outcomes": pair_outcomes_valid,
        "all_provider_calls_within_reserved_bounds": pair_outcomes_valid,
        "incremental_spend_within_cap": spend_valid,
        "provider_calls_within_total_ceiling": calls_valid,
        "provider_call_count_total": provider_calls_total,
        "provider_call_ceiling_total": TEST_ONLY_MAX_PROVIDER_CALLS,
        "incremental_spend_upper_bound_usd": incremental_upper_spend_usd,
        "incremental_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
    }


def _test_only_smoke_gate(pair: dict | None) -> dict:
    arms = pair.get("arms", {}) if isinstance(pair, dict) else {}
    calls = pair.get("provider_calls", []) if isinstance(pair, dict) else []
    both_arms_passed = (
        isinstance(arms, dict)
        and set(arms) == {"jev", "conventional"}
        and all(
            arm.get("complete") is True
            and arm.get("action_outcome_passed") is True
            and arm.get("loopback_origin_preserved") is True
            and arm.get("model_responses_valid") is True
            and not arm.get("errors")
            and not arm.get("safety_violations")
            for arm in arms.values()
        )
    )
    calls_budgeted = bool(calls) and all(_provider_call_budgeted(call) for call in calls)
    pair_cost = sum(float(call.get("conservative_charged_usd", 0)) for call in calls)
    cost = TEST_ONLY_PRIOR_RESERVED_USD + pair_cost
    passed = (
        isinstance(pair, dict)
        and pair.get("phase") == "smoke"
        and pair.get("pair_id") == f"smoke:{FAMILIES[0]}"
        and pair.get("family") == FAMILIES[0]
        and pair.get("complete_pair") is True
        and both_arms_passed
        and calls_budgeted
        and not pair.get("provider_errors")
        and not pair.get("safety_violations")
        and len(calls) <= TEST_ONLY_MAX_CALLS_PER_PAIR
        and cost <= TEST_ONLY_INCREMENTAL_CAP_USD
    )
    return {
        "passed": passed,
        "required_family": FAMILIES[0],
        "both_arms_complete_with_independent_oracles": both_arms_passed,
        "all_provider_calls_within_reserved_bounds": calls_budgeted,
        "generation_cost_reconciled": False,
        "provider_call_count": len(calls),
        "provider_call_ceiling": TEST_ONLY_MAX_CALLS_PER_PAIR,
        "incremental_cost_usd": round(cost, 12),
        "smoke_pair_cost_usd": round(pair_cost, 12),
        "prior_reserved_usd": TEST_ONLY_PRIOR_RESERVED_USD,
        "incremental_cost_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
    }


def _write_manifest(test_only_authorization: dict | None = None) -> None:
    protocol = json.loads(PROTOCOL_PATH.read_text())
    test_only = test_only_authorization is not None
    manifest = {
        "protocol_sha256": hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest(),
        "protocol_version": protocol["protocol_version"],
        "git": _git_metadata(),
        "source_sha256": _source_manifest(),
        "provider": "OpenRouter; credential supplied by process environment and never recorded",
        "prices_per_million_tokens_usd": protocol["metering"]["verified_unit_prices_usd_per_million_tokens"],
        "review_cost_usd_counted_toward_cap": REVIEW_SPEND_USD,
        "unreconciled_reviewer_spend_usd": None,
        "review_spend_reconciled": REVIEW_SPEND_RECONCILED,
        "provider_inference_enabled": REVIEW_SPEND_RECONCILED,
        "provider_inference_enabled_for_this_run": REVIEW_SPEND_RECONCILED or test_only,
        "historical_total_spend_usd": REVIEW_SPEND_USD if REVIEW_SPEND_RECONCILED else None,
        "historical_total_reconciled": REVIEW_SPEND_RECONCILED,
        "historical_unpriced_review_timeout_count": 0 if REVIEW_SPEND_RECONCILED else UNPRICED_REVIEW_TIMEOUTS,
        "test_only_authorization": test_only_authorization,
        "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD if test_only else None,
        "spend_ledger_path": str(SPEND_LEDGER_PATH),
        "operational_stop_usd": STOP_USD,
        "absolute_cap_usd": ABSOLUTE_CAP_USD,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (OUT_DIR / "protocol.json").write_text(json.dumps(protocol, indent=2, sort_keys=True) + "\n")


def _pair_plan(mode: str) -> list[tuple[str, int, str]]:
    if mode == "smoke":
        return [(f"smoke:{FAMILIES[0]}", TEST_ONLY_SMOKE_SEED, FAMILIES[0])]
    if mode == "pilot":
        return [(f"pilot:{family}", SEED + index, family) for index, family in enumerate(FAMILIES)]
    if mode != "main":
        raise ValueError(f"Unknown benchmark phase: {mode}")
    plan = []
    for family, count in FAMILY_COUNTS.items():
        for _ in range(count):
            index = len(plan)
            plan.append((f"main:{index + 1:04d}", SEED + 10_000 + index, family))
    random.Random(SEED).shuffle(plan)
    return plan


def _arm_order(pair_id: str) -> list[str]:
    arms = ["jev", "conventional"]
    pair_seed = int.from_bytes(hashlib.sha256(pair_id.encode("utf-8")).digest()[:8], "big")
    random.Random(SEED ^ pair_seed).shuffle(arms)
    return arms


def _arm_order_for_run(pair_id: str, mode: str, test_only: bool) -> list[str]:
    if test_only and mode == "smoke":
        return ["jev", "conventional"]
    return _arm_order(pair_id)


def _provider_call_reconciled(call: dict) -> bool:
    arm = call.get("arm")
    kind = call.get("kind")
    expected_model = JEV_MODEL if arm == "jev" and kind == "selector" else MERCURY_MODEL
    expected_endpoint = (
        "openrouter.ai/api/alpha/decisions" if expected_model == JEV_MODEL else "openrouter.ai/api/v1/chat/completions"
    )
    cost = call.get("generation_total_cost_usd")
    status = call.get("status")
    prompt_tokens = call.get("tokens_prompt")
    completion_tokens = call.get("tokens_completion")
    charged = call.get("conservative_charged_usd")
    usage = call.get("usage") if isinstance(call.get("usage"), dict) else {}
    response_prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    response_completion = usage.get("completion_tokens", usage.get("output_tokens"))
    input_reserve = call.get("max_input_tokens_reserved", LEGACY_INPUT_TOKEN_RESERVE)
    call_bound = _call_bound(expected_model, input_reserve) if _supported_input_reserve(input_reserve) else None
    return (
        _supported_input_reserve(input_reserve)
        and arm in {"jev", "conventional"}
        and kind in {"selector", "helper"}
        and isinstance(call.get("attempt_id"), str)
        and bool(call["attempt_id"])
        and call.get("model_requested") == expected_model
        and call.get("model") == expected_model
        and call.get("generation_model") == expected_model
        and call.get("endpoint") == expected_endpoint
        and isinstance(call.get("generation_id"), str)
        and bool(call["generation_id"])
        and isinstance(cost, (int, float))
        and not isinstance(cost, bool)
        and math.isfinite(cost)
        and call_bound is not None
        and _request_within_recorded_bounds(call, input_reserve)
        and 0 <= cost <= call_bound
        and call.get("cost_basis") == "openrouter-generation-total_cost"
        and call.get("error") is None
        and call.get("http_attempts") == 1
        and call.get("generation_lookup_attempts") == 1
        and isinstance(prompt_tokens, int)
        and not isinstance(prompt_tokens, bool)
        and 0 <= prompt_tokens <= input_reserve
        and isinstance(completion_tokens, int)
        and not isinstance(completion_tokens, bool)
        and completion_tokens >= 0
        and (expected_model != MERCURY_MODEL or completion_tokens <= MERCURY_OUTPUT_RESERVE)
        and (response_prompt is None or response_prompt == prompt_tokens)
        and (response_completion is None or response_completion == completion_tokens)
        and call.get("max_output_tokens_reserved") == (0 if expected_model == JEV_MODEL else MERCURY_OUTPUT_RESERVE)
        and isinstance(call.get("request_sha256"), str)
        and len(call["request_sha256"]) == 64
        and isinstance(status, int)
        and not isinstance(status, bool)
        and 200 <= status < 300
        and isinstance(charged, (int, float))
        and math.isclose(cost, charged, rel_tol=1e-9, abs_tol=1e-12)
    )


def _provider_call_budgeted(call: dict) -> bool:
    """Validate a test-only call charged at its pre-reserved full maximum."""
    arm = call.get("arm")
    kind = call.get("kind")
    expected_model = JEV_MODEL if arm == "jev" and kind == "selector" else MERCURY_MODEL
    expected_endpoint = (
        "openrouter.ai/api/alpha/decisions" if expected_model == JEV_MODEL else "openrouter.ai/api/v1/chat/completions"
    )
    input_reserve = call.get("max_input_tokens_reserved", LEGACY_INPUT_TOKEN_RESERVE)
    bound = _call_bound(expected_model, input_reserve) if _supported_input_reserve(input_reserve) else None
    usage = call.get("usage") if isinstance(call.get("usage"), dict) else {}
    prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion = usage.get("completion_tokens", usage.get("output_tokens"))
    charged = call.get("conservative_charged_usd")
    response_cost = call.get("response_cost_usd")
    return (
        _supported_input_reserve(input_reserve)
        and _request_within_recorded_bounds(call, input_reserve)
        and call.get("test_only_authorization_id") == TEST_ONLY_AUTHORIZATION_ID
        and arm in {"jev", "conventional"}
        and kind in {"selector", "helper"}
        and isinstance(call.get("attempt_id"), str)
        and bool(call["attempt_id"])
        and call.get("model_requested") == expected_model
        and _response_model_matches(expected_model, call.get("model"))
        and call.get("generation_model") is None
        and call.get("generation_total_cost_usd") is None
        and call.get("generation_lookup_attempts") == 0
        and call.get("generation_cost_reconciled") is False
        and call.get("endpoint") == expected_endpoint
        and call.get("cost_basis") == TEST_ONLY_FUNCTIONAL_COST_MODE
        and call.get("error") is None
        and call.get("http_attempts") == 1
        and all(
            value is None
            or (
                isinstance(value, int)
                and not isinstance(value, bool)
            and 0 <= value <= input_reserve
            )
            for value in (prompt,)
        )
        and (
            completion is None
            or (
                isinstance(completion, int)
                and not isinstance(completion, bool)
                and completion >= 0
                and (expected_model != MERCURY_MODEL or completion <= MERCURY_OUTPUT_RESERVE)
            )
        )
        and bound is not None
        and (response_cost is None or (isinstance(response_cost, (int, float)) and 0 <= response_cost <= bound))
        and call.get("max_output_tokens_reserved") == (0 if expected_model == JEV_MODEL else MERCURY_OUTPUT_RESERVE)
        and isinstance(call.get("request_sha256"), str)
        and len(call["request_sha256"]) == 64
        and isinstance(call.get("status"), int)
        and not isinstance(call.get("status"), bool)
        and 200 <= call["status"] < 300
        and isinstance(charged, (int, float))
        and math.isclose(charged, bound, rel_tol=1e-9, abs_tol=1e-12)
    )


def _pilot_gate(records: list[dict], *, functional_only: bool = False) -> dict:
    pilot = [record for record in records if record.get("phase") == "pilot"]
    expected_ids = {f"pilot:{family}" for family in FAMILIES}
    ids = [record.get("pair_id") for record in pilot]
    family_map = {record.get("family") for record in pilot}
    valid_ids = all(isinstance(pair_id, str) and pair_id for pair_id in ids)
    sample_ok = valid_ids and len(pilot) == len(FAMILIES) and len(set(ids)) == len(ids) and set(ids) == expected_ids
    sample_ok = sample_ok and family_map == set(FAMILIES)
    provider_calls = [call for record in pilot for call in record.get("provider_calls", [])]
    calls_reconciled = bool(provider_calls) and all(_provider_call_reconciled(call) for call in provider_calls)
    calls_budgeted = bool(provider_calls) and all(_provider_call_budgeted(call) for call in provider_calls)
    calls_ok = calls_budgeted if functional_only else calls_reconciled
    arms_ok = all(
        record.get("complete_pair") is True
        and set(record.get("arms", {})) == {"jev", "conventional"}
        and all(arm.get("complete") and not arm.get("errors") for arm in record["arms"].values())
        and all(
            any(call.get("arm") == arm_name and call.get("kind") == "selector" for call in record["provider_calls"])
            for arm_name in ("jev", "conventional")
        )
        for record in pilot
    )
    no_errors = all(not record.get("provider_errors") for record in pilot)
    no_safety = all(not record.get("safety_violations") for record in pilot)
    return {
        "ready_for_main": not functional_only and sample_ok and calls_ok and arms_ok and no_errors and no_safety,
        "functional_pilot_passed": functional_only and sample_ok and calls_ok and arms_ok and no_errors and no_safety,
        "five_unique_family_pairs": sample_ok,
        "all_provider_calls_reconciled": calls_reconciled,
        "all_provider_calls_within_reserved_bounds": calls_budgeted,
        "both_arms_complete": arms_ok,
        "no_provider_errors": no_errors,
        "zero_safety_violations": no_safety,
    }


def _run_benchmark_locked(
    mode: str,
    count: int | None = None,
    output_dir: Path = OUT_DIR,
    test_only_authorization: dict | None = None,
    *,
    continue_after_task_failures: bool = False,
    continuation_smoke_summary: dict | None = None,
    continuation_stop_rows: list[dict] | None = None,
    additional_pairs: list[tuple[str, int, str]] | None = None,
    skip_pair_ids: set[str] | None = None,
    allowed_unpaired_attempt_ids: set[str] | None = None,
    allowed_unpaired_pair_ids: set[str] | None = None,
) -> dict:
    global RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, OUT_DIR, REQUEST_LOG_PATH
    OUT_DIR = output_dir
    RAW_PATH, SUMMARY_PATH, MANIFEST_PATH = (
        OUT_DIR / "pairs.jsonl",
        OUT_DIR / "summary.json",
        OUT_DIR / "manifest.json",
    )
    REQUEST_LOG_PATH = OUT_DIR / "requests.jsonl"
    test_only = test_only_authorization is not None
    additional_pairs = additional_pairs or []
    skip_pair_ids = skip_pair_ids or set()
    allowed_unpaired_attempt_ids = allowed_unpaired_attempt_ids or set()
    allowed_unpaired_pair_ids = allowed_unpaired_pair_ids or set()
    supplemental_run = additional_pairs or skip_pair_ids or allowed_unpaired_attempt_ids or allowed_unpaired_pair_ids
    if supplemental_run and not test_only:
        raise MeteringError("Only an explicitly authorized test-only pilot may resume supplemental fixture pairs.")
    allowed_modes = {"pilot", "main"} | ({"smoke"} if test_only else set())
    if mode not in allowed_modes:
        raise ValueError(f"Unknown benchmark phase: {mode}")
    if count is not None and count <= 0:
        raise ValueError("--count must be positive")
    if test_only and (
        REVIEW_SPEND_RECONCILED
        or mode not in {"smoke", "pilot"}
        or test_only_authorization.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
        or not isinstance(test_only_authorization.get("run_id"), str)
        or len(test_only_authorization.get("run_id", "")) != 32
        or any(char not in "0123456789abcdef" for char in test_only_authorization.get("run_id", ""))
        or test_only_authorization.get("output_dir") != str(output_dir)
        or output_dir != TEST_ONLY_OUTPUT_ROOT
        / f"{TEST_ONLY_OUTPUT_PREFIX}{test_only_authorization.get('run_id', '')}"
        or test_only_authorization.get("incremental_new_spend_cap_usd") != TEST_ONLY_INCREMENTAL_CAP_USD
        or test_only_authorization.get("prior_reserved_usd") != TEST_ONLY_PRIOR_RESERVED_USD
        or (
            test_only_authorization.get("max_pilot_pairs"),
            test_only_authorization.get("max_run_pairs_including_smoke"),
        )
        not in {(0, 1), (TEST_ONLY_MAX_PILOT_PAIRS, TEST_ONLY_MAX_RUN_PAIRS)}
        or test_only_authorization.get("max_provider_calls_total")
        != test_only_authorization.get("max_run_pairs_including_smoke") * TEST_ONLY_MAX_CALLS_PER_PAIR
        or (mode == "pilot" and test_only_authorization.get("max_pilot_pairs") == 0)
    ):
        raise MeteringError("The one-run authorization is invalid or outside its local-fixture pilot scope.")
    if test_only:
        marker_path = output_dir / "authorization.json"
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            message = "The one-run authorization marker is missing or invalid; no requests were sent."
            raise MeteringError(message) from error
        if marker != test_only_authorization:
            raise MeteringError("The one-run authorization marker does not match; no requests were sent.")
    if not REVIEW_SPEND_RECONCILED and not test_only:
        raise MeteringError("Unreconciled reviewer spend blocks all provider inference; no requests were sent.")
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise MeteringError("OPENROUTER_API_KEY is missing; no provider calls were made.")
    previous = _read_records(RAW_PATH)
    stop_path = OUT_DIR / "stop.jsonl"
    continuation_valid = False
    if continue_after_task_failures:
        smoke_rows = [record for record in previous if record.get("phase") == "smoke"]
        if not test_only or mode != "pilot" or len(smoke_rows) != 1 or not stop_path.is_file():
            raise MeteringError("Task-failure continuation requires the original authorized smoke row.")
        try:
            continuation_valid = _test_only_smoke_continuation_gate(
                smoke_rows[0],
                continuation_stop_rows if continuation_stop_rows is not None else _read_records(stop_path),
                continuation_smoke_summary
                if continuation_smoke_summary is not None
                else json.loads((OUT_DIR / "summary.json").read_text(encoding="utf-8")),
            )["passed"]
        except (OSError, json.JSONDecodeError) as error:
            raise MeteringError("Failed-smoke continuation evidence is missing or invalid.") from error
        if not continuation_valid:
            raise MeteringError("Failed smoke is not an eligible task outcome; no pilot requests were sent.")
    if stop_path.exists() and stop_path.stat().st_size:
        if not continuation_valid:
            raise MeteringError("A prior stop record blocks benchmark resumption; manual review required.")
    pair_ids = [item.get("pair_id") for item in previous]
    if any(not isinstance(pair_id, str) or not pair_id for pair_id in pair_ids):
        raise MeteringError("Existing pair records contain invalid IDs; inference is blocked.")
    if len(pair_ids) != len(set(pair_ids)):
        raise MeteringError("Existing pair records contain duplicate IDs; inference is blocked.")
    plan = _pair_plan("pilot") + _pair_plan("main") + additional_pairs
    if test_only:
        plan += _pair_plan("smoke")
    plan_by_id = {pair_id: family for pair_id, _seed, family in plan}
    if (
        len(plan_by_id) != len(plan)
        or any(pair_id not in {item[0] for item in _pair_plan("pilot")} for pair_id in skip_pair_ids)
        or (
            allowed_unpaired_attempt_ids
            and not allowed_unpaired_attempt_ids.issubset(
                {call.get("attempt_id") for call in _read_records(SPEND_LEDGER_PATH) if call.get("event") == "attempt"}
            )
        )
    ):
        raise MeteringError("Supplemental pilot schedule or preserved partial-attempt authorization is invalid.")
    if any(
        item.get("phase") not in ({"pilot", "main", "smoke"} if test_only else {"pilot", "main"})
        or plan_by_id.get(item.get("pair_id")) != item.get("family")
        for item in previous
    ):
        raise MeteringError(
            "Existing pair records do not match the unique phase/family schedule; inference is blocked."
        )
    ledger_spend, ledger_attempts = _load_spend_ledger(
        SPEND_LEDGER_PATH,
        REQUEST_LOG_PATH,
        functional_authorization_id=TEST_ONLY_AUTHORIZATION_ID if test_only else None,
    )
    record_call_ids = [call.get("attempt_id") for item in previous for call in item.get("provider_calls", [])]
    ledger_call_ids = [item.get("attempt_id") for item in ledger_attempts]
    if any(not isinstance(attempt_id, str) or not attempt_id for attempt_id in record_call_ids + ledger_call_ids):
        raise MeteringError("Pair and ledger records contain invalid attempt IDs; inference is blocked.")
    if (
        len(record_call_ids) != len(set(record_call_ids))
        or len(ledger_call_ids) != len(set(ledger_call_ids))
        or set(ledger_call_ids) != set(record_call_ids) | allowed_unpaired_attempt_ids
    ):
        raise MeteringError("Durable ledger and pair records disagree; manual reconciliation required.")
    pair_records = set(pair_ids)
    unpaired_attempts = [item for item in ledger_attempts if item.get("attempt_id") in allowed_unpaired_attempt_ids]
    if (
        {item.get("pair_id") for item in ledger_attempts} - pair_records != allowed_unpaired_pair_ids
        or {item.get("pair_id") for item in unpaired_attempts} != allowed_unpaired_pair_ids
    ):
        raise MeteringError(
            "Ledger contains an interrupted pair not preserved in its recovery artifact; "
            "manual reconciliation required."
        )
    if any(item.get("provider_calls") for item in previous) and not ledger_attempts:
        raise MeteringError("Existing provider results have no durable ledger; inference is blocked.")
    if mode == "main":
        pilot_gate = _pilot_gate(previous)
        if not pilot_gate["ready_for_main"]:
            raise MeteringError(f"Pilot acceptance gate failed: {pilot_gate}; no main requests were sent.")
        completed_main = sum(item.get("phase") == "main" for item in previous)
        projected = max(0, MAIN_PAIRS - completed_main) * PAIR_BOUND
        if REVIEW_SPEND_USD + ledger_spend + projected > STOP_USD:
            raise BudgetStop("The post-pilot upper-bound projection exceeds the $24 operational stop.")
    existing = {item.get("pair_id") for item in previous}
    base_plan = _pair_plan(mode)
    replacements = [
        item
        for item in additional_pairs
        if any(base[0] in skip_pair_ids and base[2] == item[2] for base in base_plan)
    ]
    ordered_plan = []
    used_replacements = set()
    for item in base_plan:
        if item[0] in skip_pair_ids:
            for replacement in replacements:
                if replacement[2] == item[2]:
                    ordered_plan.append(replacement)
                    used_replacements.add(replacement[0])
        else:
            ordered_plan.append(item)
    ordered_plan.extend(item for item in additional_pairs if item[0] not in used_replacements)
    plan = [
        item
        for item in ordered_plan
        if item[0] not in existing and item[0] not in skip_pair_ids
    ]
    if count is not None:
        plan = plan[:count]
    _write_manifest(test_only_authorization)
    client = httpx.Client(timeout=30, http2=True)
    meter = CostMeter(
        client,
        api_key,
        0.0 if test_only else REVIEW_SPEND_USD,
            prior_spend_usd=ledger_spend + (TEST_ONLY_PRIOR_RESERVED_USD if test_only else 0.0),
        prior_attempts=ledger_attempts,
        ledger_path=SPEND_LEDGER_PATH,
        test_only_authorization_id=TEST_ONLY_AUTHORIZATION_ID if test_only else None,
    )
    completed = 0
    try:
        with fixture_server() as origin:
            for pair_id, seed, family in plan:
                meter.reserve_pair(pair_id, mode)
                trial = make_trial(family, seed)
                order = _arm_order_for_run(pair_id, mode, test_only)
                calls_before = len(meter.calls)
                arms = {}
                for arm in order:
                    try:
                        arms[arm] = run_arm(origin, trial, arm, meter)
                    except (BudgetStop, MeteringError) as error:
                        _append_record(
                            OUT_DIR / "stop.jsonl",
                            {"after_pair": pair_id, "arm": arm, "reason": type(error).__name__, "detail": str(error)},
                        )
                        raise
                    if continue_after_task_failures:
                        if not _recordable_task_outcome(arms[arm]):
                            break
                    elif not arms[arm].get("complete") or arms[arm].get("errors") or arms[arm].get("safety_violations"):
                        break
                pair_calls = meter.calls[calls_before:]
                safety = [issue for result in arms.values() for issue in result.get("safety_violations", [])]
                provider_errors = [call["error"] for call in pair_calls if call.get("error")]
                stop_reason = (
                    "safety violation"
                    if safety
                    else "provider error"
                    if provider_errors
                    else "fixture/oracle or arm failure"
                    if len(arms) != 2
                    or any(not result.get("complete") or result.get("errors") for result in arms.values())
                    else None
                )
                task_failure_recorded = bool(
                    continue_after_task_failures
                    and stop_reason == "fixture/oracle or arm failure"
                    and len(arms) == 2
                    and all(_recordable_task_outcome(arm) for arm in arms.values())
                )
                record = {
                    "phase": mode,
                    "pair_id": pair_id,
                    "family": family,
                    "complete_pair": len(arms) == 2,
                    "seed": seed,
                    "arm_order": order,
                    "goal": trial["goal"],
                    "expected_oracle": trial["expected"],
                    "arms": arms,
                    "provider_errors": provider_errors,
                    "safety_violations": safety,
                    "stop_reason": stop_reason,
                    "task_failure_recorded": task_failure_recorded,
                    "continued_after_task_failure": task_failure_recorded,
                    "provider_calls": pair_calls,
                    "conservative_cost_usd": round(sum(call["conservative_charged_usd"] for call in pair_calls), 12),
                    "cumulative_upper_spend_usd_including_review": (
                        None if test_only else round(meter.cumulative_upper_usd, 12)
                    ),
                    "test_only_authorization_id": TEST_ONLY_AUTHORIZATION_ID if test_only else None,
                    "incremental_new_spend_usd": round(meter.charged_usd, 12) if test_only else None,
                    "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD if test_only else None,
                    "historical_known_reviewer_spend_lower_bound_usd": REVIEW_SPEND_USD if test_only else None,
                    "historical_total_spend_usd": None if test_only else round(meter.cumulative_upper_usd, 12),
                }
                _append_record(RAW_PATH, record)
                completed += 1
                meter.release_pair(pair_id)
                if stop_reason and not task_failure_recorded:
                    _append_record(OUT_DIR / "stop.jsonl", {"after_pair": pair_id, "reason": stop_reason})
                    break
        records = _read_records(RAW_PATH)
        summary = (
            {
                "phase": "smoke",
                "attempted_pairs": len([item for item in records if item.get("phase") == "smoke"]),
                "pairs": len([item for item in records if item.get("phase") == "smoke" and item.get("complete_pair")]),
                "target_pairs": 1,
            }
            if mode == "smoke"
            else analyze(records, mode, functional_only=test_only)
        )
        summary["batch_pairs_completed"] = completed
        summary["cumulative_upper_spend_usd_including_review"] = (
            None if test_only else round(meter.cumulative_upper_usd, 12)
        )
        summary["pilot_operational_gate"] = _pilot_gate(records, functional_only=test_only)
        if test_only:
            summary.update(
                {
                    "test_only_authorization": test_only_authorization,
                    "incremental_new_spend_usd": round(meter.charged_usd, 12),
                    "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
                "provider_calls_total": len(meter.prior_attempts) + len(meter.calls),
                "prior_reserved_usd": TEST_ONLY_PRIOR_RESERVED_USD,
                    "historical_known_reviewer_spend_lower_bound_usd": REVIEW_SPEND_USD,
                    "historical_unpriced_review_timeout_count": UNPRICED_REVIEW_TIMEOUTS,
                    "historical_total_spend_usd": None,
                    "historical_total_reconciled": False,
                    "original_total_cap_usd": ABSOLUTE_CAP_USD,
                    "original_total_cap_compliance_confirmed": False,
                    "statistical_superiority_claimed": False,
                }
            )
        SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        return summary
    finally:
        client.close()


def run_benchmark(mode: str, count: int | None = None, output_dir: Path = OUT_DIR) -> dict:
    if mode not in {"pilot", "main"}:
        raise ValueError(f"Unknown benchmark phase: {mode}")
    if count is not None and count <= 0:
        raise ValueError("--count must be positive")
    if not REVIEW_SPEND_RECONCILED:
        raise MeteringError("Unreconciled reviewer spend blocks all provider inference; no requests were sent.")
    with _exclusive_run_lock(SPEND_LEDGER_PATH.with_suffix(".lock")):
        return _run_benchmark_locked(mode, count, output_dir)


def _write_test_only_authorization(path: Path, authorization: dict) -> None:
    encoded = json.dumps(authorization, indent=2, sort_keys=True) + "\n"
    with path.open("x", encoding="utf-8") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _test_only_ledger_spend_upper_bound(path: Path) -> float | None:
    if not path.is_file():
        return TEST_ONLY_PRIOR_RESERVED_USD
    attempts: dict[str, float] = {}
    settlements: dict[str, float] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            entry = json.loads(line)
            attempt_id = entry["attempt_id"]
            if entry.get("event") == "attempt":
                attempts[attempt_id] = float(entry["reserved_usd"])
            elif entry.get("event") == "settlement":
                settlements[attempt_id] = float(entry["charged_usd"])
            else:
                return None
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None
    if set(settlements) - set(attempts):
        return None
    return TEST_ONLY_PRIOR_RESERVED_USD + sum(
        settlements.get(attempt_id, reserve) for attempt_id, reserve in attempts.items()
    )


def _authorized_smoke_failure_for_continuation(
    output_dir: Path,
) -> tuple[dict, dict, dict, float, int, int, list[dict]]:
    """Validate the smoke and, once, an earlier continuation stopped before new calls."""
    output_dir = output_dir.resolve()
    if output_dir.parent != TEST_ONLY_OUTPUT_ROOT.resolve() or not output_dir.name.startswith(TEST_ONLY_OUTPUT_PREFIX):
        raise MeteringError("Pilot continuation must use an existing isolated test-only run directory.")
    try:
        authorization = json.loads((output_dir / "authorization.json").read_text(encoding="utf-8"))
        latest_summary = json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))
        records = _read_records(output_dir / "pairs.jsonl")
        stop_rows = _read_records(output_dir / "stop.jsonl")
    except (OSError, json.JSONDecodeError) as error:
        raise MeteringError("Existing smoke artifacts are missing or invalid; no requests were sent.") from error

    run_id = output_dir.name.removeprefix(TEST_ONLY_OUTPUT_PREFIX)
    if (
        authorization.get("schema_version") != "jev-test-only-authorization.v1"
        or authorization.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
        or authorization.get("authorization_source_thread_id") != "01a0b2d1-2554-7ce1-936b-49bf4561a8cb"
        or authorization.get("run_id") != run_id
        or authorization.get("output_dir") != str(output_dir)
        or authorization.get("max_pilot_pairs") != TEST_ONLY_MAX_PILOT_PAIRS
        or authorization.get("max_run_pairs_including_smoke") != TEST_ONLY_MAX_RUN_PAIRS
        or authorization.get("max_provider_calls_total") != TEST_ONLY_MAX_PROVIDER_CALLS
        or authorization.get("max_provider_calls_per_pair") != TEST_ONLY_MAX_CALLS_PER_PAIR
        or authorization.get("incremental_new_spend_cap_usd") != TEST_ONLY_INCREMENTAL_CAP_USD
        or authorization.get("prior_reserved_usd") != TEST_ONLY_PRIOR_RESERVED_USD
    ):
        raise MeteringError("Existing authorization does not cover this five-pair continuation; no requests were sent.")
    attempt_number = 1
    summary = latest_summary
    smoke_stop_rows = stop_rows
    first_attempt_marker = output_dir / "pilot-continuation.json"
    recovery_marker = output_dir / "pilot-continuation-recovery-1.json"
    if first_attempt_marker.exists():
        if recovery_marker.exists():
            raise MeteringError("The one allowed pre-provider recovery attempt was already used.")
        try:
            first_attempt = json.loads(first_attempt_marker.read_text(encoding="utf-8"))
            first_result = json.loads((output_dir / "pilot-continuation-result.json").read_text(encoding="utf-8"))
            summary = json.loads((output_dir / "smoke-summary-original.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise MeteringError("The prior continuation history is incomplete; no recovery is allowed.") from error
        if (
            len(stop_rows) != 2
            or stop_rows[1].get("test_only_authorization_id") != TEST_ONLY_AUTHORIZATION_ID
            or stop_rows[1].get("phase") != "pilot"
            or stop_rows[1].get("reason") != "MeteringError"
            or not str(stop_rows[1].get("detail", "")).startswith("Functional-only provider attempt ")
            or not str(stop_rows[1].get("detail", "")).endswith(" is outside its one-run authorization.")
            or latest_summary.get("status") != "PILOT_STOPPED"
            or latest_summary.get("completed_pair_ids") != [f"smoke:{FAMILIES[0]}"]
            or first_result.get("status") != "PILOT_STOPPED"
            or first_result.get("schema_version") != "jev-test-only-continuation-result.v1"
            or first_attempt.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
            or first_attempt.get("source_run_id") != run_id
            or first_attempt.get("output_dir") != str(output_dir)
            or first_attempt.get("max_pilot_pairs") != TEST_ONLY_MAX_PILOT_PAIRS
            or first_attempt.get("max_provider_calls_total") != TEST_ONLY_MAX_PROVIDER_CALLS
            or first_attempt.get("incremental_new_spend_cap_usd") != TEST_ONLY_INCREMENTAL_CAP_USD
            or not all(
                (output_dir / name).is_file()
                for name in (
                    "smoke-summary-original.json",
                    "smoke-manifest-original.json",
                    "smoke-protocol-original.json",
                )
            )
        ):
            raise MeteringError("Prior continuation is not the single known pre-provider metering stop.")
        attempt_number = 2
        smoke_stop_rows = stop_rows[:1]
    if len(records) != 1 or any(record.get("phase") != "smoke" for record in records):
        raise MeteringError("Continuation requires exactly the original smoke row and no pilot rows.")
    gate = _test_only_smoke_continuation_gate(records[0], smoke_stop_rows, summary)
    if not gate["passed"]:
        raise MeteringError(f"Smoke failure is not an eligible task outcome: {gate['reason']}")

    pair_calls = records[0].get("provider_calls", [])
    if len(pair_calls) > TEST_ONLY_MAX_CALLS_PER_PAIR or any(not _provider_call_budgeted(call) for call in pair_calls):
        raise MeteringError("Original smoke provider calls fail their reserved bounds; no requests were sent.")
    ledger_path = output_dir / "spend-ledger.jsonl"
    request_path = output_dir / "requests.jsonl"
    _ledger_spend, ledger_attempts = _load_spend_ledger(
        ledger_path,
        request_path,
        functional_authorization_id=TEST_ONLY_AUTHORIZATION_ID,
    )
    pair_attempt_ids = [call.get("attempt_id") for call in pair_calls]
    ledger_attempt_ids = [call.get("attempt_id") for call in ledger_attempts]
    if len(pair_attempt_ids) != len(ledger_attempt_ids) or set(pair_attempt_ids) != set(ledger_attempt_ids):
        raise MeteringError("Smoke pair and durable spend ledger do not reconcile; no requests were sent.")
    if attempt_number == 2:
        request_rows = _read_records(request_path)
        request_ids = [call.get("attempt_id") for call in request_rows]
        if (
            first_attempt.get("prior_provider_call_count") != len(pair_calls)
            or first_attempt.get("prior_incremental_upper_bound_usd") is None
            or not math.isclose(
                first_attempt["prior_incremental_upper_bound_usd"],
                _test_only_ledger_spend_upper_bound(ledger_path) or 0.0,
                rel_tol=1e-9,
                abs_tol=1e-12,
            )
            or first_result.get("provider_calls_total") != len(pair_calls)
            or latest_summary.get("provider_calls_total") != len(pair_calls)
            or first_result.get("pilot_run_integrity_gate", {}).get("provider_call_count_total") != len(pair_calls)
            or len(request_ids) != len(pair_attempt_ids)
            or set(request_ids) != set(pair_attempt_ids)
            or any(
                row.get("phase") != "smoke" or row.get("pair_id") != f"smoke:{FAMILIES[0]}"
                for row in request_rows
            )
            or any(
                item.get("phase") != "smoke" or item.get("pair_id") != f"smoke:{FAMILIES[0]}"
                for item in ledger_attempts
            )
        ):
            raise MeteringError("Prior continuation has provider activity beyond the original smoke; recovery blocked.")
    spend_upper = _test_only_ledger_spend_upper_bound(ledger_path)
    if spend_upper is None or spend_upper + TEST_ONLY_MAX_PILOT_PAIRS * PAIR_BOUND > TEST_ONLY_INCREMENTAL_CAP_USD:
        raise BudgetStop("The existing smoke reserve plus all five pilot-pair bounds exceeds the $2 cap.")
    if len(ledger_attempts) + TEST_ONLY_MAX_PILOT_PAIRS * TEST_ONLY_MAX_CALLS_PER_PAIR > TEST_ONLY_MAX_PROVIDER_CALLS:
        raise BudgetStop("The existing smoke calls plus all five pair ceilings exceed the authorized call bound.")
    return authorization, summary, records[0], spend_upper, len(ledger_attempts), attempt_number, smoke_stop_rows


def _write_exclusive_bytes(path: Path, contents: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _smoke_failure_summary(
    authorization: dict,
    output_dir: Path,
    error: Exception | None = None,
    *,
    phase: str = "smoke",
) -> dict:
    ledger = output_dir / "spend-ledger.jsonl"
    spend = _test_only_ledger_spend_upper_bound(ledger)
    reason = None if error is None else f"{type(error).__name__}: {error}"
    return {
        "phase": phase,
        "status": "SMOKE_FAILED" if error is None else "STOPPED",
        "test_only_authorization": authorization,
        "stop_reason": reason or "Independent smoke oracle, response, safety, or metering gate failed.",
        "smoke_gate": {"passed": False},
        "incremental_new_spend_upper_bound_usd": spend,
        "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
        "prior_reserved_usd": TEST_ONLY_PRIOR_RESERVED_USD,
        "historical_known_reviewer_spend_lower_bound_usd": REVIEW_SPEND_USD,
        "historical_unpriced_review_timeout_count": UNPRICED_REVIEW_TIMEOUTS,
        "historical_total_spend_usd": None,
        "historical_total_reconciled": False,
        "original_total_cap_usd": ABSOLUTE_CAP_USD,
        "original_total_cap_compliance_confirmed": False,
        "statistical_superiority_claimed": False,
    }


def _run_test_only_authorized(*, include_pilot: bool) -> dict:
    """Run the authorized smoke; the pilot path is opt-in and never used by smoke-only mode."""
    if REVIEW_SPEND_RECONCILED:
        raise MeteringError("This test-only override is only available while reviewer spend is unreconciled.")
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise MeteringError("OPENROUTER_API_KEY is missing; no provider calls were made.")
    max_run_pairs = TEST_ONLY_MAX_RUN_PAIRS if include_pilot else 1
    if TEST_ONLY_PRIOR_RESERVED_USD + max_run_pairs * PAIR_BOUND > TEST_ONLY_INCREMENTAL_CAP_USD:
        raise MeteringError(
            "The full authorized rate bound plus prior reserve exceeds $2; no provider calls were made."
        )
    if not include_pilot and TEST_ONLY_SMOKE_RETRY_MARKER.exists():
        raise MeteringError("The single corrected smoke retry was already consumed; no provider calls were made.")
    run_id = uuid.uuid4().hex
    output_dir = TEST_ONLY_OUTPUT_ROOT / f"{TEST_ONLY_OUTPUT_PREFIX}{run_id}"
    if output_dir.exists():
        raise MeteringError("The fresh one-run output path already exists; refusing to reuse authorization.")

    output_dir.mkdir(parents=True, exist_ok=False)
    authorization = _test_only_authorization_record(run_id, output_dir, include_pilot=include_pilot)
    _write_test_only_authorization(output_dir / "authorization.json", authorization)
    if not include_pilot:
        try:
            _write_test_only_authorization(
                TEST_ONLY_SMOKE_RETRY_MARKER,
                {
                    "authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                    "prior_failed_run_id": "89cfd75e0427405ab7b60cdd83d6ae30",
                    "prior_reserved_usd": TEST_ONLY_PRIOR_RESERVED_USD,
                    "run_id": run_id,
                    "output_dir": str(output_dir),
                },
            )
        except FileExistsError as error:
            raise MeteringError(
                "The single corrected smoke retry was already consumed; no provider calls were made."
            ) from error

    global OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH
    previous_paths = (OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH)
    OUT_DIR = output_dir
    SPEND_LEDGER_PATH = output_dir / "spend-ledger.jsonl"
    try:
        with _exclusive_run_lock(SPEND_LEDGER_PATH.with_suffix(".lock")):
            smoke_gate = None
            try:
                _run_benchmark_locked("smoke", 1, output_dir, authorization)
                records = _read_records(output_dir / "pairs.jsonl")
                smoke_gate = _test_only_smoke_gate(records[0] if len(records) == 1 else None)
                if not smoke_gate["passed"]:
                    summary = _smoke_failure_summary(authorization, output_dir, phase="smoke")
                    summary["smoke_gate"] = smoke_gate
                    SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
                    return summary

                if not include_pilot:
                    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
                    summary["status"] = "SMOKE_PASSED"
                    summary["smoke_gate"] = smoke_gate
                    summary["pilot_execution"] = "not authorized for this run"
                    summary["prior_reserved_usd"] = TEST_ONLY_PRIOR_RESERVED_USD
                    SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
                    return summary

                summary = _run_benchmark_locked(
                    "pilot", TEST_ONLY_MAX_PILOT_PAIRS, output_dir, authorization
                )
                summary["smoke_gate"] = smoke_gate
                summary["pilot_execution"] = (
                    "Five paired local-fixture families; functional evidence only, no statistical superiority claim."
                )
                SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
                return summary
            except Exception as error:
                stop_path = output_dir / "stop.jsonl"
                _append_record(
                    stop_path,
                    {
                        "test_only_authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                        "reason": type(error).__name__,
                        "detail": str(error),
                    },
                )
                summary = _smoke_failure_summary(
                    authorization,
                    output_dir,
                    error,
                    phase="pilot" if smoke_gate is not None and include_pilot else "smoke",
                )
                if smoke_gate is not None:
                    summary["smoke_gate"] = smoke_gate
                try:
                    completed_pairs = _read_records(output_dir / "pairs.jsonl")
                except (OSError, json.JSONDecodeError, MeteringError):
                    completed_pairs = []
                summary["completed_pair_ids"] = [item.get("pair_id") for item in completed_pairs]
                SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
                return summary
    finally:
        OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH = previous_paths


def run_test_only_authorized_smoke() -> dict:
    """Run the single authorized corrected Jev-first smoke pair; never continue into pilot pairs."""
    return _run_test_only_authorized(include_pilot=False)


def run_test_only_authorized_pilot() -> dict:
    """Run one functional smoke pair, then five budgeted pilot pairs on smoke success."""
    return _run_test_only_authorized(include_pilot=True)


def run_test_only_authorized_pilot_continuation(output_dir: Path) -> dict:
    """Continue from an authorized smoke task failure, including one verified zero-call recovery."""
    if REVIEW_SPEND_RECONCILED:
        return {
            "phase": "pilot",
            "status": "CONTINUATION_BLOCKED",
            "reason": "The test-only continuation applies only while historical reviewer spend remains unreconciled.",
            "provider_calls_made": 0,
        }
    if not os.environ.get("OPENROUTER_API_KEY"):
        return {
            "phase": "pilot",
            "status": "CONTINUATION_BLOCKED",
            "reason": "OPENROUTER_API_KEY is missing; no provider calls were made.",
            "provider_calls_made": 0,
        }

    output_dir = Path(output_dir).resolve()
    global OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH
    previous_paths = (OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH)
    OUT_DIR = output_dir
    RAW_PATH, SUMMARY_PATH, MANIFEST_PATH = (
        output_dir / "pairs.jsonl",
        output_dir / "summary.json",
        output_dir / "manifest.json",
    )
    REQUEST_LOG_PATH = output_dir / "requests.jsonl"
    SPEND_LEDGER_PATH = output_dir / "spend-ledger.jsonl"
    try:
        with _exclusive_run_lock(SPEND_LEDGER_PATH.with_suffix(".lock")):
            try:
                (
                    authorization,
                    original_summary,
                    smoke_pair,
                    prior_spend,
                    prior_call_count,
                    attempt_number,
                    smoke_stop_rows,
                ) = (
                    _authorized_smoke_failure_for_continuation(output_dir)
                )
            except (BudgetStop, MeteringError) as error:
                return {
                    "phase": "pilot",
                    "status": "CONTINUATION_BLOCKED",
                    "reason": f"{type(error).__name__}: {error}",
                    "provider_calls_made": 0,
                }

            if attempt_number == 1:
                original_files = (
                    (SUMMARY_PATH, output_dir / "smoke-summary-original.json"),
                    (MANIFEST_PATH, output_dir / "smoke-manifest-original.json"),
                    (output_dir / "protocol.json", output_dir / "smoke-protocol-original.json"),
                )
                try:
                    for source, destination in original_files:
                        if not source.is_file():
                            raise MeteringError(f"Original smoke artifact is missing: {source.name}")
                        _write_exclusive_bytes(destination, source.read_bytes())
                except (OSError, MeteringError) as error:
                    return {
                        "phase": "pilot",
                        "status": "CONTINUATION_BLOCKED",
                        "reason": f"{type(error).__name__}: {error}",
                        "provider_calls_made": 0,
                    }

            suffix = "" if attempt_number == 1 else "-recovery-1"
            continuation_marker_path = output_dir / f"pilot-continuation{suffix}.json"
            continuation_result_path = output_dir / f"pilot-continuation{suffix}-result.json"

            errors = [
                error
                for arm in smoke_pair["arms"].values()
                for error in arm.get("errors", [])
            ]
            continuation = {
                "schema_version": "jev-test-only-continuation.v1",
                "authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                "authorization_source_thread_id": "01a0b2d1-2554-7ce1-936b-49bf4561a8cb",
                "authorized_by": "Pablo",
                "source_run_id": authorization["run_id"],
                "output_dir": str(output_dir),
                "continuation_attempt_number": attempt_number,
                "recovery_of_zero_provider_call_failure": attempt_number == 2,
                "continuation": "five independent local-fixture family pairs; no smoke rerun",
                "smoke_pair_id": smoke_pair["pair_id"],
                "smoke_failure_errors": errors,
                "raw_model_response_saved": False,
                "underlying_response_mismatch": "unknown",
                "prior_incremental_upper_bound_usd": prior_spend,
                "prior_provider_call_count": prior_call_count,
                "max_pilot_pairs": TEST_ONLY_MAX_PILOT_PAIRS,
                "max_provider_calls_total": TEST_ONLY_MAX_PROVIDER_CALLS,
                "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
                "protocol_sha256": hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest(),
            }
            _write_test_only_authorization(continuation_marker_path, continuation)

            try:
                summary = _run_benchmark_locked(
                    "pilot",
                    TEST_ONLY_MAX_PILOT_PAIRS,
                    output_dir,
                    authorization,
                    continue_after_task_failures=True,
                    continuation_smoke_summary=original_summary,
                    continuation_stop_rows=smoke_stop_rows,
                )
            except Exception as error:
                _append_record(
                    output_dir / "stop.jsonl",
                    {
                        "test_only_authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                        "phase": "pilot",
                        "reason": type(error).__name__,
                        "detail": str(error),
                    },
                )
                summary = _smoke_failure_summary(authorization, output_dir, error, phase="pilot")
                summary["completed_pair_ids"] = [item.get("pair_id") for item in _read_records(RAW_PATH)]

            records = _read_records(RAW_PATH)
            smoke_gate = _test_only_smoke_gate(smoke_pair)
            spend_upper = _test_only_ledger_spend_upper_bound(SPEND_LEDGER_PATH)
            try:
                _ledger_spend, ledger_attempts = _load_spend_ledger(
                    SPEND_LEDGER_PATH,
                    REQUEST_LOG_PATH,
                    functional_authorization_id=TEST_ONLY_AUTHORIZATION_ID,
                )
                calls_total = len(ledger_attempts)
                ledger_valid = True
            except MeteringError:
                calls_total = sum(
                    1 for row in _read_records(SPEND_LEDGER_PATH) if row.get("event") == "attempt"
                )
                ledger_valid = False
            attempt_gate = _pilot_attempt_integrity_gate(
                records,
                incremental_upper_spend_usd=spend_upper,
                provider_calls_total=calls_total,
            )
            attempt_gate["spend_ledger_reconciled"] = ledger_valid
            attempt_gate["passed"] = attempt_gate["passed"] and ledger_valid
            summary.update(
                {
                    "phase": "pilot",
                    "status": "PILOT_COMPLETED" if attempt_gate["passed"] else "PILOT_STOPPED",
                    "smoke_gate": smoke_gate,
                    "original_smoke_summary_status": original_summary.get("status"),
                    "original_smoke_failure": {
                        "pair_id": smoke_pair["pair_id"],
                        "stop_reason": smoke_pair.get("stop_reason"),
                        "failed_arms": [
                            {
                                "arm": name,
                                "errors": arm.get("errors", []),
                                "complete": arm.get("complete"),
                                "model_responses_valid": arm.get("model_responses_valid"),
                            }
                            for name, arm in smoke_pair["arms"].items()
                            if arm.get("complete") is not True
                        ],
                        "raw_model_response_saved": False,
                        "underlying_response_mismatch": "unknown",
                    },
                    "continuation": {
                        "authorized": True,
                        "attempt_number": attempt_number,
                        "recovery_of_zero_provider_call_failure": attempt_number == 2,
                        "smoke_rerun": False,
                        "pilot_pairs_requested": TEST_ONLY_MAX_PILOT_PAIRS,
                        "task_failures_retained": True,
                    },
                    "pilot_run_integrity_gate": attempt_gate,
                    "pilot_execution": (
                        "Five unique local-fixture family pairs attempted; task failures retained as outcomes; "
                        "functional evidence only, no statistical superiority claim."
                    ),
                    "statistical_superiority_claimed": False,
                    "incremental_new_spend_upper_bound_usd": spend_upper,
                    "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
                    "provider_calls_total": calls_total,
                }
            )
            SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            _write_test_only_authorization(
                continuation_result_path,
                {
                    "schema_version": "jev-test-only-continuation-result.v1",
                    "status": summary["status"],
                    "continuation_attempt_number": attempt_number,
                    "recovery_of_zero_provider_call_failure": attempt_number == 2,
                    "completed_pair_ids": summary.get("completed_pair_ids", []),
                    "pilot_run_integrity_gate": attempt_gate,
                    "incremental_new_spend_upper_bound_usd": spend_upper,
                    "provider_calls_total": calls_total,
                    "original_smoke_failure_preserved": True,
                },
            )
            return summary
    finally:
        OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH = previous_paths


def _authorized_pilot_resume_after_request_bound_stop(
    output_dir: Path,
) -> tuple[dict, dict, dict, list[dict], list[dict], list[dict], float, int]:
    """Validate prior pilot work and permit only missing families plus a named fresh form-preview pair."""
    output_dir = output_dir.resolve()
    if output_dir.parent != TEST_ONLY_OUTPUT_ROOT.resolve() or not output_dir.name.startswith(TEST_ONLY_OUTPUT_PREFIX):
        raise MeteringError("Pilot resume must use the existing isolated test-only run directory.")
    try:
        authorization = json.loads((output_dir / "authorization.json").read_text(encoding="utf-8"))
        latest_summary = json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))
        original_summary = json.loads((output_dir / "smoke-summary-original.json").read_text(encoding="utf-8"))
        first_marker = json.loads((output_dir / "pilot-continuation.json").read_text(encoding="utf-8"))
        recovery_marker = json.loads((output_dir / "pilot-continuation-recovery-1.json").read_text(encoding="utf-8"))
        first_result = json.loads((output_dir / "pilot-continuation-result.json").read_text(encoding="utf-8"))
        recovery_result = json.loads(
            (output_dir / "pilot-continuation-recovery-1-result.json").read_text(encoding="utf-8")
        )
        records = _read_records(output_dir / "pairs.jsonl")
        stop_rows = _read_records(output_dir / "stop.jsonl")
        requests = _read_records(output_dir / "requests.jsonl")
    except (OSError, json.JSONDecodeError, MeteringError) as error:
        raise MeteringError(
            "Existing pilot continuation artifacts are missing or invalid; no calls were sent."
        ) from error

    run_id = output_dir.name.removeprefix(TEST_ONLY_OUTPUT_PREFIX)
    if (
        authorization.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
        or authorization.get("authorization_source_thread_id") != "01a0b2d1-2554-7ce1-936b-49bf4561a8cb"
        or authorization.get("run_id") != run_id
        or authorization.get("output_dir") != str(output_dir)
        or authorization.get("max_pilot_pairs") != TEST_ONLY_MAX_PILOT_PAIRS
        or authorization.get("max_provider_calls_total") != TEST_ONLY_MAX_PROVIDER_CALLS
        or authorization.get("incremental_new_spend_cap_usd") != TEST_ONLY_INCREMENTAL_CAP_USD
        or first_marker.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
        or recovery_marker.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
        or recovery_marker.get("continuation_attempt_number") != 2
        or recovery_marker.get("recovery_of_zero_provider_call_failure") is not True
        or recovery_result.get("continuation_attempt_number") != 2
        or recovery_result.get("status") != "PILOT_STOPPED"
        or first_result.get("provider_calls_total") != 9
        or latest_summary.get("status") != "PILOT_STOPPED"
    ):
        raise MeteringError("This run is outside the single authorized post-stop resume state.")

    expected_record_ids = {
        f"smoke:{FAMILIES[0]}",
        "pilot:autocomplete_search",
        "pilot:filter_select",
        "pilot:long_page_navigation",
    }
    record_ids = {row.get("pair_id") for row in records}
    smoke_rows = [row for row in records if row.get("phase") == "smoke"]
    smoke_stop = stop_rows[:1]
    if (
        len(records) != 4
        or record_ids != expected_record_ids
        or len(smoke_rows) != 1
        or not _test_only_smoke_continuation_gate(smoke_rows[0], smoke_stop, original_summary)["passed"]
        or latest_summary.get("completed_pair_ids") != [
            f"smoke:{FAMILIES[0]}",
            "pilot:autocomplete_search",
            "pilot:filter_select",
            "pilot:long_page_navigation",
        ]
        or len(stop_rows) < 4
        or stop_rows[1].get("phase") != "pilot"
        or stop_rows[1].get("reason") != "MeteringError"
        or not str(stop_rows[1].get("detail", "")).endswith(" is outside its one-run authorization.")
        or stop_rows[2].get("after_pair") != "pilot:form_preview"
        or stop_rows[2].get("arm") != "conventional"
        or stop_rows[2].get("reason") != "MeteringError"
        or "Request size 8764 exceeds the predeclared 8192-byte bound" not in str(stop_rows[2].get("detail", ""))
        or stop_rows[3].get("phase") != "pilot"
        or stop_rows[3].get("reason") != "MeteringError"
        or "Request size 8764 exceeds the predeclared 8192-byte bound" not in str(stop_rows[3].get("detail", ""))
        or any(
            row.get("phase") != "pilot" or row.get("reason") not in {"MeteringError", "BudgetStop"}
            for row in stop_rows[4:]
        )
    ):
        raise MeteringError("Saved pilot rows or stop history do not match the observed interrupted run.")

    for row in records:
        if row.get("phase") == "pilot" and (
            row.get("provider_errors")
            or row.get("safety_violations")
            or any(not _recordable_task_outcome(arm) for arm in row.get("arms", {}).values())
            or any(not _provider_call_budgeted(call) for call in row.get("provider_calls", []))
        ):
            raise MeteringError("Previously recorded pilot outcome fails its safety or call-bound checks.")

    partial_pair_id = "pilot:form_preview"
    partial_calls = [call for call in requests if call.get("pair_id") == partial_pair_id]
    if (
        len(partial_calls) != 5
        or any(call.get("arm") != "jev" or call.get("phase") != "pilot" for call in partial_calls)
        or sum(call.get("kind") == "selector" for call in partial_calls) != 4
        or sum(call.get("kind") == "helper" for call in partial_calls) != 1
        or any(not _provider_call_budgeted(call) for call in partial_calls)
        or any(not call.get("attempt_id") for call in partial_calls)
    ):
        raise MeteringError("The interrupted form-preview calls are not an exact safe partial attempt.")

    ledger_path = output_dir / "spend-ledger.jsonl"
    request_path = output_dir / "requests.jsonl"
    try:
        _ledger_spend, ledger_attempts = _load_spend_ledger(
            ledger_path,
            request_path,
            functional_authorization_id=TEST_ONLY_AUTHORIZATION_ID,
        )
    except MeteringError as error:
        raise MeteringError(f"Saved pilot spend ledger cannot resume safely: {error}") from error
    request_ids = [call.get("attempt_id") for call in requests]
    ledger_ids = [call.get("attempt_id") for call in ledger_attempts]
    recorded_ids = [call.get("attempt_id") for row in records for call in row.get("provider_calls", [])]
    partial_ids = [call.get("attempt_id") for call in partial_calls]
    if (
        len(request_ids) != len(set(request_ids))
        or len(ledger_ids) != len(set(ledger_ids))
        or len(recorded_ids) != len(set(recorded_ids))
        or len(partial_ids) != len(set(partial_ids))
        or set(request_ids) != set(ledger_ids)
        or set(recorded_ids) | set(partial_ids) != set(ledger_ids)
        or {item.get("pair_id") for item in ledger_attempts if item.get("attempt_id") in partial_ids}
        != {partial_pair_id}
        or len(ledger_attempts) != 32
        or recovery_result.get("provider_calls_total") != len(ledger_attempts)
    ):
        raise MeteringError("Request log, pair rows, partial attempt, and spend ledger do not reconcile exactly.")

    resume_marker_path = output_dir / "pilot-continuation-resume-1.json"
    resume_result_paths = sorted(output_dir.glob("pilot-continuation-resume-1*-result.json"))
    if resume_result_paths and not resume_marker_path.exists():
        raise MeteringError("A resume result exists without its preserved resume marker.")
    if resume_marker_path.exists():
        try:
            resume_marker = json.loads(resume_marker_path.read_text(encoding="utf-8"))
            prior_resume_result = (
                json.loads(resume_result_paths[-1].read_text(encoding="utf-8")) if resume_result_paths else None
            )
        except (OSError, json.JSONDecodeError) as error:
            raise MeteringError("Prior pre-provider resume history is invalid; no calls were sent.") from error
        if (
            resume_marker.get("authorization_id") != TEST_ONLY_AUTHORIZATION_ID
            or resume_marker.get("prior_provider_call_count") != len(ledger_attempts)
            or resume_marker.get("prior_provider_attempt_ids") != sorted(request_ids)
            or resume_marker.get("prior_pair_ids") != sorted(expected_record_ids)
            or latest_summary.get("provider_calls_total") != len(ledger_attempts)
            or (prior_resume_result is not None and (
                prior_resume_result.get("status") != "PILOT_STOPPED"
                or prior_resume_result.get("provider_calls_total") != len(ledger_attempts)
                or prior_resume_result.get("completed_pair_ids") != latest_summary.get("completed_pair_ids")
            ))
        ):
            raise MeteringError("A previous resume made provider calls or changed pair rows; no retry is allowed.")

    current_upper = _test_only_ledger_spend_upper_bound(ledger_path)
    projected_upper = current_upper + 2 * PAIR_BOUND if current_upper is not None else math.inf
    projected_calls = len(ledger_attempts) + 2 * TEST_ONLY_MAX_CALLS_PER_PAIR
    if current_upper is None or projected_upper > TEST_ONLY_INCREMENTAL_CAP_USD:
        raise BudgetStop("The remaining two fixture pairs exceed the authorized $2 cumulative cap.")
    if projected_calls > TEST_ONLY_MAX_PROVIDER_CALLS:
        raise BudgetStop("The remaining two fixture pairs exceed the authorized 96-call ceiling.")
    return (
        authorization,
        original_summary,
        smoke_rows[0],
        partial_calls,
        records,
        ledger_attempts,
        current_upper,
        projected_calls,
    )


def run_test_only_authorized_pilot_resume(output_dir: Path) -> dict:
    """Resume the remaining fixture families after preserving a pre-send request-bound stop."""
    if REVIEW_SPEND_RECONCILED:
        return {
            "phase": "pilot",
            "status": "RESUME_BLOCKED",
            "reason": (
                "This explicit functional-only resume applies only while historical reviewer spend is unreconciled."
            ),
            "provider_calls_made": 0,
        }
    if not os.environ.get("OPENROUTER_API_KEY"):
        return {
            "phase": "pilot",
            "status": "RESUME_BLOCKED",
            "reason": "OPENROUTER_API_KEY is missing.",
            "provider_calls_made": 0,
        }

    output_dir = Path(output_dir).resolve()
    global OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH
    previous_paths = (OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH)
    OUT_DIR = output_dir
    RAW_PATH, SUMMARY_PATH, MANIFEST_PATH = (
        output_dir / "pairs.jsonl",
        output_dir / "summary.json",
        output_dir / "manifest.json",
    )
    REQUEST_LOG_PATH = output_dir / "requests.jsonl"
    SPEND_LEDGER_PATH = output_dir / "spend-ledger.jsonl"
    try:
        with _exclusive_run_lock(SPEND_LEDGER_PATH.with_suffix(".lock")):
            try:
                (
                    authorization,
                    original_smoke_summary,
                    smoke_pair,
                    partial_calls,
                    prior_records,
                    prior_attempts,
                    prior_upper,
                    projected_calls,
                ) = _authorized_pilot_resume_after_request_bound_stop(output_dir)
            except (BudgetStop, MeteringError) as error:
                return {
                    "phase": "pilot",
                    "status": "RESUME_BLOCKED",
                    "reason": f"{type(error).__name__}: {error}",
                    "provider_calls_made": 0,
                }

            partial_path = output_dir / "pilot-form-preview-partial-attempt.json"
            prior_resume_results = sorted(output_dir.glob("pilot-continuation-resume-1*-result.json"))
            resume_attempt_number = len(prior_resume_results) + 1
            resume_result_path = (
                output_dir / "pilot-continuation-resume-1-result.json"
                if resume_attempt_number == 1
                else output_dir / f"pilot-continuation-resume-1-precall-retry-{resume_attempt_number - 1}-result.json"
            )
            partial = {
                "schema_version": "jev-test-only-partial-pair.v1",
                "authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                "original_pair_id": "pilot:form_preview",
                "family": "form_preview",
                "seed": SEED + FAMILIES.index("form_preview"),
                "pair_row_written": False,
                "arm_outcome_durable": False,
                "arm_outcome_inferred": False,
                "new_provider_calls_after_this_partial_attempt": 0,
                "partial_calls_count_toward_budget": True,
                "raw_response_evidence_saved_at_time": False,
                "calls": partial_calls,
                "stop_reason": (
                    "Conventional request was rejected before send at 8764 bytes; "
                    "the prior limit was 8192 bytes."
                ),
            }
            try:
                if partial_path.exists():
                    existing_partial = json.loads(partial_path.read_text(encoding="utf-8"))
                    if existing_partial != partial:
                        raise MeteringError("A conflicting partial form-preview artifact already exists.")
                else:
                    _write_test_only_authorization(partial_path, partial)
                for source, destination in (
                    (SUMMARY_PATH, output_dir / "pilot-continuation-recovery-1-summary.json"),
                    (MANIFEST_PATH, output_dir / "pilot-continuation-recovery-1-manifest.json"),
                ):
                    if not destination.exists():
                        _write_exclusive_bytes(destination, source.read_bytes())
            except (OSError, json.JSONDecodeError, MeteringError) as error:
                return {
                    "phase": "pilot",
                    "status": "RESUME_BLOCKED",
                    "reason": f"{type(error).__name__}: {error}",
                    "provider_calls_made": 0,
                }

            stop_rows = _read_records(output_dir / "stop.jsonl")[:1]
            resume_marker = {
                "schema_version": "jev-test-only-pilot-resume.v1",
                "authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                "authorization_source_thread_id": "01a0b2d1-2554-7ce1-936b-49bf4561a8cb",
                "source_run_id": authorization["run_id"],
                "output_dir": str(output_dir),
                "resume_number": 1,
                "reason": (
                    "Continue after the 8764-byte Mercury request was rejected before send; "
                    "use common 16384-byte and 16384-token bounds."
                ),
                "previous_partial_attempt_artifact": str(partial_path),
                "skip_pair_ids": ["pilot:form_preview"],
                "additional_pair": {
                    "pair_id": TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID,
                    "family": "form_preview",
                    "seed": TEST_ONLY_FORM_PREVIEW_RECOVERY_SEED,
                    "label": "fresh complete form_preview pair after interrupted partial attempt",
                },
                "remaining_planned_pair_ids": [
                    TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID,
                    "pilot:delayed_control",
                ],
                "request_body_max_bytes": REQUEST_MAX_BYTES,
                "reserved_input_tokens_per_request": INPUT_TOKEN_RESERVE,
                "jev_call_bound_usd": JEV_CALL_BOUND,
                "mercury_call_bound_usd": MERCURY_CALL_BOUND,
                "pair_bound_usd": PAIR_BOUND,
                "prior_incremental_upper_bound_usd": prior_upper,
                "prior_provider_call_count": len(prior_attempts),
                "prior_provider_attempt_ids": sorted(call.get("attempt_id") for call in prior_attempts),
                "prior_pair_ids": sorted(row.get("pair_id") for row in prior_records),
                "max_remaining_pair_reserve_usd": 2 * PAIR_BOUND,
                "projected_incremental_upper_bound_usd": prior_upper + 2 * PAIR_BOUND,
                "projected_provider_calls_total_ceiling": projected_calls,
                "provider_calls_total_ceiling": TEST_ONLY_MAX_PROVIDER_CALLS,
                "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
                "raw_responses_and_offered_choices_saved_to": "model-evidence.jsonl",
                "protocol_sha256": hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest(),
            }
            resume_marker_path = output_dir / "pilot-continuation-resume-1.json"
            if not resume_marker_path.exists():
                _write_test_only_authorization(resume_marker_path, resume_marker)
            try:
                summary = _run_benchmark_locked(
                    "pilot",
                    None,
                    output_dir,
                    authorization,
                    continue_after_task_failures=True,
                    continuation_smoke_summary=original_smoke_summary,
                    continuation_stop_rows=stop_rows,
                    additional_pairs=[
                        (
                            TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID,
                            TEST_ONLY_FORM_PREVIEW_RECOVERY_SEED,
                            "form_preview",
                        )
                    ],
                    skip_pair_ids={"pilot:form_preview"},
                    allowed_unpaired_attempt_ids={call["attempt_id"] for call in partial_calls},
                    allowed_unpaired_pair_ids={"pilot:form_preview"},
                )
            except Exception as error:
                _append_record(
                    output_dir / "stop.jsonl",
                    {
                        "test_only_authorization_id": TEST_ONLY_AUTHORIZATION_ID,
                        "phase": "pilot",
                        "reason": type(error).__name__,
                        "detail": str(error),
                    },
                )
                summary = _smoke_failure_summary(authorization, output_dir, error, phase="pilot")
                summary["completed_pair_ids"] = [item.get("pair_id") for item in _read_records(RAW_PATH)]

            records = _read_records(RAW_PATH)
            spend_upper = _test_only_ledger_spend_upper_bound(SPEND_LEDGER_PATH)
            try:
                _ledger_spend, ledger_attempts = _load_spend_ledger(
                    SPEND_LEDGER_PATH,
                    REQUEST_LOG_PATH,
                    functional_authorization_id=TEST_ONLY_AUTHORIZATION_ID,
                )
                calls_total = len(ledger_attempts)
                ledger_valid = True
                attempt_ids = [item.get("attempt_id") for item in ledger_attempts]
                record_ids = [call.get("attempt_id") for row in records for call in row.get("provider_calls", [])]
                partial_ids = [call.get("attempt_id") for call in partial_calls]
                partial_reconciled = (
                    len(attempt_ids) == len(set(attempt_ids))
                    and set(attempt_ids) == set(record_ids) | set(partial_ids)
                )
            except MeteringError:
                calls_total = sum(
                    1 for row in _read_records(SPEND_LEDGER_PATH) if row.get("event") == "attempt"
                )
                ledger_valid = False
                partial_reconciled = False
            attempt_gate = _pilot_attempt_integrity_gate(
                records,
                incremental_upper_spend_usd=spend_upper,
                provider_calls_total=calls_total,
            )
            attempt_gate["spend_ledger_reconciled"] = ledger_valid
            attempt_gate["partial_attempt_reconciled"] = partial_reconciled
            attempt_gate["passed"] = attempt_gate["passed"] and ledger_valid and partial_reconciled
            summary.update(
                {
                    "phase": "pilot",
                    "status": "PILOT_COMPLETED" if attempt_gate["passed"] else "PILOT_STOPPED",
                    "smoke_gate": _test_only_smoke_gate(smoke_pair),
                    "original_smoke_summary_status": original_smoke_summary.get("status"),
                    "continuation_resume_number": 1,
                    "partial_form_preview_attempt": str(partial_path),
                    "fresh_form_preview_pair_id": TEST_ONLY_FORM_PREVIEW_RECOVERY_PAIR_ID,
                    "pilot_run_integrity_gate": attempt_gate,
                    "pilot_execution": (
                        "Remaining local-fixture families attempted under the original authorization; "
                        "all prior task failures and partial calls included; no superiority claim."
                    ),
                    "statistical_superiority_claimed": False,
                    "incremental_new_spend_upper_bound_usd": spend_upper,
                    "incremental_new_spend_cap_usd": TEST_ONLY_INCREMENTAL_CAP_USD,
                    "provider_calls_total": calls_total,
                }
            )
            summary["completed_pair_ids"] = [row.get("pair_id") for row in records]
            SUMMARY_PATH.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            _write_test_only_authorization(
                resume_result_path,
                {
                    "schema_version": "jev-test-only-pilot-resume-result.v1",
                    "status": summary["status"],
                    "resume_attempt_number": resume_attempt_number,
                    "completed_pair_ids": summary.get("completed_pair_ids", []),
                    "stop_reason": summary.get("stop_reason"),
                    "partial_pair_artifact": str(partial_path),
                    "pilot_run_integrity_gate": attempt_gate,
                    "incremental_new_spend_upper_bound_usd": spend_upper,
                    "provider_calls_total": calls_total,
                    "previous_partial_attempts_preserved": True,
                },
            )
            return summary
    finally:
        OUT_DIR, RAW_PATH, SUMMARY_PATH, MANIFEST_PATH, REQUEST_LOG_PATH, SPEND_LEDGER_PATH = previous_paths


def _quantile(values: list[float], p: float) -> float | None:
    clean = sorted(float(value) for value in values if value is not None and math.isfinite(float(value)))
    if not clean:
        return None
    pos = (len(clean) - 1) * p
    lo = int(pos)
    hi = min(lo + 1, len(clean) - 1)
    return clean[lo] + (clean[hi] - clean[lo]) * (pos - lo)


def _arm_metric(record: dict, arm: str, metric: str) -> float:
    data = record["arms"][arm]
    if metric == "completion":
        return float(bool(data.get("complete")))
    if metric == "latency":
        return float(data.get("end_to_end_ms", 0))
    if metric == "decision_latency":
        values = data.get("decision_latency_ms", [])
        return float(statistics.mean(values)) if values else 0.0
    if metric == "cost":
        return float(data.get("cost_usd", 0))
    raise ValueError(metric)


def _stratified_bootstrap(records: list[dict], statistic, seed: int, replicates: int = BOOTSTRAP_REPLICATES) -> dict:
    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        groups[record["family"]].append(record)
    if not groups or any(not rows for rows in groups.values()):
        return {"low": None, "high": None, "replicates": 0}
    rng = random.Random(seed)
    samples = []
    for _ in range(replicates):
        draw = {family: rng.choices(rows, k=len(rows)) for family, rows in groups.items()}
        value = statistic(draw)
        if value is not None and math.isfinite(value):
            samples.append(value)
    return {"low": _quantile(samples, 0.025), "high": _quantile(samples, 0.975), "replicates": len(samples)}


def analyze(records: list[dict], phase: str, *, functional_only: bool = False) -> dict:
    phase_records = [record for record in records if record.get("phase") == phase]
    rows = [
        record
        for record in records
        if record.get("phase") == phase and set(record.get("arms", {})) == {"jev", "conventional"}
    ]
    by_family: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_family[row["family"]].append(row)
    metrics = {}
    for arm in ("jev", "conventional"):
        completion = [_arm_metric(row, arm, "completion") for row in rows]
        latency = [_arm_metric(row, arm, "latency") for row in rows]
        decisions = [value for row in rows for value in row["arms"][arm].get("decision_latency_ms", [])]
        helpers = [value for row in rows for value in row["arms"][arm].get("helper_latency_ms", [])]
        cost = sum(_arm_metric(row, arm, "cost") for row in rows)
        completed_count = int(sum(completion))
        metrics[arm] = {
            "completion_rate": statistics.mean(completion) if completion else None,
            "completed": completed_count,
            "attempted": len(rows),
            "end_to_end_ms": {"p50": _quantile(latency, 0.5), "p95": _quantile(latency, 0.95)},
            "decision_latency_ms": {"p50": _quantile(decisions, 0.5), "p95": _quantile(decisions, 0.95)},
            "helper_latency_ms": {"p50": _quantile(helpers, 0.5), "p95": _quantile(helpers, 0.95)},
            "selector_calls": sum(
                sum(call.get("kind") == "selector" for call in row["arms"][arm].get("provider_calls", []))
                for row in rows
            ),
            "helper_calls": sum(
                sum(call.get("kind") == "helper" for call in row["arms"][arm].get("provider_calls", [])) for row in rows
            ),
            "conservative_cost_usd": round(cost, 12),
            "cost_per_completed_workflow_usd": round(cost / completed_count, 12) if completed_count else None,
            "cost_per_attempt_usd": round(cost / len(rows), 12) if rows else None,
            "stale_recovery_fallbacks": sum(bool(row["arms"][arm].get("fallback_used")) for row in rows),
            "stale_recoveries": sum(int(row["arms"][arm].get("stale_recoveries", 0)) for row in rows),
        }

    def completion_delta(draw):
        return statistics.mean(
            statistics.mean(
                _arm_metric(row, "jev", "completion") - _arm_metric(row, "conventional", "completion")
                for row in family_rows
            )
            for family_rows in draw.values()
        )

    completion_ci = _stratified_bootstrap(rows, completion_delta, SEED + 1)

    def latency_delta(draw, p):
        return statistics.mean(
            _quantile([_arm_metric(row, "conventional", "latency") for row in family_rows], p)
            - _quantile([_arm_metric(row, "jev", "latency") for row in family_rows], p)
            for family_rows in draw.values()
        )

    p50_ci = _stratified_bootstrap(rows, lambda draw: latency_delta(draw, 0.5), SEED + 2)
    p95_ci = _stratified_bootstrap(rows, lambda draw: latency_delta(draw, 0.95), SEED + 3)

    def cost_delta(draw):
        return statistics.mean(
            statistics.mean(
                _arm_metric(row, "conventional", "cost") - _arm_metric(row, "jev", "cost") for row in family_rows
            )
            for family_rows in draw.values()
        )

    cost_ci = _stratified_bootstrap(rows, cost_delta, SEED + 4)
    safety_count = sum(len(row.get("safety_violations", [])) for row in rows)
    paired_n = len(rows)
    floor_met = all((metrics[arm]["completion_rate"] or 0) >= 0.95 for arm in metrics)
    noninferior = completion_ci["low"] is not None and completion_ci["low"] > -0.02
    pair_ids = [row.get("pair_id") for row in rows]
    unique_pair_ids = all(isinstance(pair_id, str) and pair_id for pair_id in pair_ids) and len(set(pair_ids)) == len(
        pair_ids
    )
    family_counts = {family: len(by_family.get(family, [])) for family in FAMILIES}
    allocation_met = family_counts == (FAMILY_COUNTS if phase == "main" else dict.fromkeys(FAMILIES, 1))
    expected_main = {pair_id: family for pair_id, _seed, family in _pair_plan("main")}
    schedule_met = phase != "main" or (
        unique_pair_ids
        and set(pair_ids) == set(expected_main)
        and all(expected_main.get(row.get("pair_id")) == row.get("family") for row in rows)
    )
    complete_main = phase == "main" and paired_n == MAIN_PAIRS and unique_pair_ids and allocation_met and schedule_met
    provider_calls = [call for row in rows for arm in row["arms"].values() for call in arm.get("provider_calls", [])]
    all_provider_calls_reconciled = bool(provider_calls) and all(
        _provider_call_reconciled(call) for call in provider_calls
    )
    all_provider_calls_budgeted = bool(provider_calls) and all(
        _provider_call_budgeted(call) for call in provider_calls
    )
    provider_errors = sum(len(row.get("provider_errors", [])) for row in rows) + sum(
        len(arm.get("errors", [])) for row in rows for arm in row["arms"].values()
    )
    gate_met = (
        complete_main
        and safety_count == 0
        and floor_met
        and noninferior
        and provider_errors == 0
        and all_provider_calls_reconciled
    )
    performance_superiority = any(ci["low"] is not None and ci["low"] > 0 for ci in (p50_ci, p95_ci, cost_ci))
    pilot_gate = _pilot_gate(records, functional_only=functional_only)
    if phase == "pilot":
        verdict = (
            "FUNCTIONAL_ONLY_PILOT_COMPLETE"
            if pilot_gate["functional_pilot_passed"]
            else "PILOT_READY"
            if pilot_gate["ready_for_main"]
            else "INCONCLUSIVE"
            if paired_n < len(FAMILIES)
            else "FAIL"
        )
    else:
        verdict = "PASS" if gate_met else "INCONCLUSIVE" if paired_n < MAIN_PAIRS else "FAIL"
    per_family = {
        family: {
            arm: {
                "completion_rate": statistics.mean([_arm_metric(row, arm, "completion") for row in family_rows]),
                "pairs": len(family_rows),
            }
            for arm in ("jev", "conventional")
        }
        for family, family_rows in by_family.items()
    }
    return {
        "phase": phase,
        "attempted_pairs": len(phase_records),
        "pairs": paired_n,
        "incomplete_or_unpaired_records": len(phase_records) - paired_n,
        "target_pairs": 5 if phase == "pilot" else MAIN_PAIRS,
        "per_family": per_family,
        "arms": metrics,
        "completion_difference_jev_minus_conventional": {
            "completion_rate": completion_delta({key: group for key, group in by_family.items()})
            if by_family
            else None,
            "completion_rate_95pct_ci": completion_ci,
        },
        "latency_difference_conventional_minus_jev": {
            "end_to_end_p50_ms_95pct_ci": p50_ci,
            "end_to_end_p95_ms_95pct_ci": p95_ci,
        },
        "cost_difference_conventional_minus_jev": {
            "cost_per_attempt_usd_95pct_ci": cost_ci,
        },
        "provider_provenance": {
            "requested_models": sorted({str(call.get("model_requested")) for call in provider_calls}),
            "response_models": sorted({str(call.get("model")) for call in provider_calls}),
            "generation_models": sorted({str(call.get("generation_model")) for call in provider_calls}),
            "endpoints": sorted({str(call.get("endpoint")) for call in provider_calls}),
            "all_costs_and_usage_reconciled": all_provider_calls_reconciled,
            "all_provider_calls_within_predeclared_reserves": all_provider_calls_budgeted,
            "accounting_mode": (
                "full_call_reserve; generation metadata not queried" if functional_only else "generation metadata"
            ),
            "provider_errors": provider_errors,
        },
        "gates": {
            "zero_safety_violations": safety_count == 0,
            "completion_floor_each_arm_95pct": floor_met,
            "paired_noninferiority_margin_minus_2pp": noninferior,
            "unique_pair_ids": unique_pair_ids,
            "family_allocation_met": allocation_met,
            "exact_predeclared_pair_schedule": schedule_met,
            "provider_provenance_reconciled": all_provider_calls_reconciled,
            "provider_calls_within_predeclared_reserves": all_provider_calls_budgeted,
            "zero_provider_errors": provider_errors == 0,
            "full_powered_sample": complete_main,
            "completion_gate": gate_met,
            "performance_superiority_supported": gate_met and performance_superiority,
            "status": verdict,
        },
        "pilot_operational_gate": pilot_gate,
        "limitations": (
            "The five fixed scenario families are not independent samples of websites; "
            "conclusions are limited to seeded local fixture variants."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    phase = parser.add_mutually_exclusive_group(required=True)
    phase.add_argument("--pilot", action="store_true", help="run five pilot pairs, one per fixture family")
    phase.add_argument("--main", action="store_true", help="run the predeclared 2,627-pair main sample")
    phase.add_argument(
        "--test-only-authorized-pilot",
        action="store_true",
        help="one-shot local-fixture pilot with Pablo's recorded $2 incremental authorization",
    )
    phase.add_argument(
        "--continue-test-only-authorized-pilot",
        action="store_true",
        help="continue once from an eligible failed smoke in its existing authorized output directory",
    )
    phase.add_argument(
        "--resume-test-only-authorized-pilot",
        action="store_true",
        help="resume the unattempted fixture families after a preserved pre-send request-bound stop",
    )
    phase.add_argument(
        "--test-only-authorized-smoke",
        action="store_true",
        help="single Jev-first local-fixture smoke pair; no pilot continuation",
    )
    parser.add_argument("--count", type=int, help="run at most this many remaining pairs in this batch")
    parser.add_argument("--output-dir", type=Path, default=OUT_DIR)
    args = parser.parse_args()
    if args.test_only_authorized_pilot:
        if args.count is not None or args.output_dir != OUT_DIR:
            parser.error("--test-only-authorized-pilot fixes its five-pair scope and isolated output path")
        summary = run_test_only_authorized_pilot()
        print(json.dumps(summary, indent=2, sort_keys=True))
        passed = summary.get("smoke_gate", {}).get("passed") is True and summary.get(
            "pilot_operational_gate", {}
        ).get("functional_pilot_passed") is True
        return 0 if passed else 2
    if args.continue_test_only_authorized_pilot:
        if args.count is not None or args.output_dir == OUT_DIR:
            parser.error(
                "--continue-test-only-authorized-pilot requires its existing --output-dir and fixed five-pair scope"
            )
        summary = run_test_only_authorized_pilot_continuation(args.output_dir)
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0 if summary.get("pilot_run_integrity_gate", {}).get("passed") is True else 2
    if args.resume_test_only_authorized_pilot:
        if args.count is not None or args.output_dir == OUT_DIR:
            parser.error("--resume-test-only-authorized-pilot requires the existing run --output-dir")
        summary = run_test_only_authorized_pilot_resume(args.output_dir)
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0 if summary.get("pilot_run_integrity_gate", {}).get("passed") is True else 2
    if args.test_only_authorized_smoke:
        if args.count is not None or args.output_dir != OUT_DIR:
            parser.error("--test-only-authorized-smoke fixes its one-pair scope and isolated output path")
        summary = run_test_only_authorized_smoke()
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0 if summary.get("smoke_gate", {}).get("passed") is True else 2
    mode = "pilot" if args.pilot else "main"
    summary = run_benchmark(mode, args.count, args.output_dir)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
