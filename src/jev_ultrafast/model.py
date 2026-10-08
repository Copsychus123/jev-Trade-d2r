"""TypeSafe makes choices; an optional small OpenAI-compatible model writes field values."""

import json
import logging
import math
import random
import time
from collections import Counter

import httpx

from .config import HTTP_TIMEOUT_SECONDS, TYPESAFE_ENDPOINT, get_settings
from .questions import BASE_PICK, NEXT_ACTION, TARGET

logger = logging.getLogger(__name__)

CLIENT = httpx.Client(timeout=HTTP_TIMEOUT_SECONDS)


def _retry_pause(attempt, max_retries, initial_delay, max_delay, deadline):
    """Sleep before the next attempt. False when there is none: attempts used up, or the pause would end at or after
    `deadline` (a time on the time.monotonic() clock)."""
    if attempt >= max_retries - 1:
        return False
    delay = min(initial_delay * (2**attempt), max_delay) * (1 + random.uniform(0, 0.1))
    if deadline is not None and time.monotonic() + delay >= deadline:
        return False
    time.sleep(delay)
    return True


def _request_timeout(timeout, deadline):
    """Seconds one attempt may take: `timeout` (default HTTP_TIMEOUT_SECONDS) cut to the time left before `deadline`.
    None when neither is given: the client's own default applies."""
    if timeout is None and deadline is None:
        return None
    seconds = HTTP_TIMEOUT_SECONDS if timeout is None else timeout
    if deadline is not None:
        seconds = min(seconds, deadline - time.monotonic())
    return seconds


def _preview(response):
    """The first 200 characters of a response body for an error message: what the provider sent, never the request."""
    try:
        text = response.text
    except Exception:
        return ""
    return text[:200] if isinstance(text, str) else ""


def post_json(url, key, body, *, timeout=None, deadline=None):
    """POST `body` and return the JSON reply; retries only network errors and HTTP 429/503/529.

    `timeout` limits one attempt and `deadline` (time.monotonic() seconds) limits all attempts together: no attempt
    starts after it, no pause ends after it and an attempt never runs past it. Without both the demo behaviour is
    unchanged (HTTP_TIMEOUT_SECONDS per attempt, `api_retry_count` attempts)."""
    settings = get_settings()
    max_retries = max(1, settings.api_retry_count)
    initial_delay = settings.api_initial_retry_delay_seconds
    max_delay = settings.api_max_retry_delay_seconds

    attempts: list[str] = []
    for attempt in range(max_retries):
        seconds = _request_timeout(timeout, deadline)
        if seconds is not None and seconds <= 0:
            attempts.append(f"attempt {attempt + 1}: time limit reached")
            break
        options = {} if seconds is None else {"timeout": seconds}
        try:
            response = CLIENT.post(url, json=body, headers={"Authorization": f"Bearer {key}"}, **options)
        except httpx.HTTPError as exc:
            attempts.append(f"attempt {attempt + 1}: network error ({exc})")
            if _retry_pause(attempt, max_retries, initial_delay, max_delay, deadline):
                continue
            raise RuntimeError(
                f"Model connection failed after {len(attempts)} attempts: {'; '.join(attempts)}"
            ) from None

        if response.status_code in {429, 529, 503}:
            preview = _preview(response)
            note = f"attempt {attempt + 1}: HTTP {response.status_code}"
            attempts.append(f"{note} {preview}" if preview else note)
            if _retry_pause(attempt, max_retries, initial_delay, max_delay, deadline):
                continue
            break

        if response.is_error:
            preview = _preview(response)
            raise RuntimeError(
                f"Model provider returned HTTP {response.status_code}" + (f": {preview}" if preview else "")
                + "; no action executed."
            )

        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Failed to parse JSON response from model provider (HTTP {response.status_code}): "
                f"{_preview(response)}"
            ) from exc
        except (httpx.TimeoutException, TimeoutError) as exc:
            logger.error("Network timeout during json() call: %s", exc)
            raise

    raise RuntimeError(f"Model unavailable after {len(attempts)} attempts: {'; '.join(attempts)}")


def check_provider_result(result):
    """The provider's reply must be a dict with a dict of answers and numeric usage values. Anything else is the
    provider's fault (RuntimeError), never something to blame on the caller."""
    usage = result.get("usage") if isinstance(result, dict) else None
    usage = {} if usage is None else usage
    if (
        not isinstance(result, dict)
        or not isinstance(result.get("answers"), dict)
        or not isinstance(usage, dict)
        or not all(type(n) in (int, float) and math.isfinite(n) for n in usage.values())
    ):
        raise RuntimeError("Invalid TypeSafe response shape; no action executed.")
    return result


def validate_choice(answer, ids):
    try:
        probabilities = answer["probabilities"]
        numbers = list(probabilities.values())
        valid = (
            answer["choice"] in ids
            and set(probabilities) == set(ids)
            and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in numbers)
            and abs(sum(probabilities.values()) - 1) < 0.02
            and probabilities[answer["choice"]] >= max(probabilities.values()) - 1e-6
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        raise ValueError("Invalid TypeSafe response; no action executed.")
    return answer


MAX_SAME_NAME_ELEMENTS = 2

def action_space(actions):
    """One index per observed element; each operation has its own valid target choices."""
    elements, indices, targets, controls = [], {}, {}, {}
    operations = {"click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT"}
    same_name, skipped = Counter(), set()
    for action in actions:
        kind = action["kind"]
        if kind not in operations:
            controls[action["id"].upper()] = action
            continue
        node = action["node"]
        if node in skipped:
            continue
        if node not in indices:
            label = action["label"].split(" → ")[0]
            # Repeats such as 26 "Min"/"Max" boxes cost tokens and add nothing a choice can use: keep the first few.
            same_name[label, action.get("role")] += 1
            if same_name[label, action.get("role")] > MAX_SAME_NAME_ELEMENTS:
                skipped.add(node)
                continue
            index = str(len(elements) + 1)
            indices[node] = index
            element = {k: action[k] for k in ("role", "value", "checked", "selected", "expanded") if k in action}
            element.update(index=index, label=label)
            if kind == "select":
                element["value"] = action.get("current_value", "")
                element["options"] = []
            elements.append(element)
        index = indices[node]
        operation = operations[kind]
        group = targets.setdefault(operation, {})
        element = elements[int(index) - 1]
        target = index
        if kind == "select":
            target = f"{index}:{len(element['options']) + 1}"
            element["options"].append({"index": target, "label": action["label"], "value": action["value"]})
        group[target] = action
    return elements, targets, controls


# A chosen target below this probability means Jev could not tell the candidates apart (for example four links with the
# same name). Executing it risks leaving the page, so Jev is asked once more without that operation.
MIN_TARGET_PROBABILITY = 0.5


def _request(state, goal, history, elements, targets, controls, allow_blocked=True):
    labels = {
        "CLICK": "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
        "SELECT": "Select an observed dropdown value.",
    }
    operations = {key: labels[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations["DONE"] = "Every requirement is visibly satisfied."
    if allow_blocked:
        operations["BLOCKED"] = "No supported operation can progress."
    questions = {
        "operation": {"type": "choice", "criteria": operations, "instructions": {"goal": goal, "rules": NEXT_ACTION}}
    }
    for operation, candidates in targets.items():
        questions[operation.lower() + "_target"] = {
            "type": "choice",
            # The details (label, role, value, state) are already in `state.elements`; repeating them per option
            # only costs tokens, so an option is just the element index.
            "criteria": {index: None for index in candidates},
            "instructions": {
                "goal": goal,
                "operation": operation,
                "options": "Each option is the index of an entry in `elements`.",
                "rules": TARGET,
            },
        }
    body = {
        "model": get_settings().typesafe_model,
        "state": {
            "page": {k: state[k] for k in ("url", "title", "text")},
            "elements": elements,
            "recent_actions": [
                {k: h.get(k) for k in ("action", "kind", "text", "page_changed")} for h in history[-30:]
            ],
            # How often each action was already executed (the caller passes the current phase only): counting a
            # limit such as "at most N presses" from a list of actions was unreliable.
            "action_counts": dict(Counter(h.get("action") for h in history)),
        },
        "questions": questions,
    }
    return body, operations


def _resolve(result, operations, targets, controls):
    """Validate the answers and turn them into one decision. Only the head of the chosen operation is consumed."""
    operation_answer = validate_choice(result["answers"].get("operation", {}), operations)
    operation = operation_answer["choice"]
    target = None
    target_answer = None
    probabilities = {}
    if operation in targets:
        # Unused target heads cannot cause an action. Validate the head selected by the operation.
        target_answer = validate_choice(result["answers"].get(operation.lower() + "_target", {}), targets[operation])
        target = target_answer["choice"]
        choice = targets[operation][target]["id"]
        probabilities = {a["id"]: target_answer["probabilities"][index] for index, a in targets[operation].items()}
    else:
        choice = controls[operation]["id"] if operation in controls else operation
        probabilities[choice] = operation_answer["probabilities"][operation]
    return {
        "choice": choice,
        "operation": operation,
        "target": target,
        "probabilities": probabilities,
        "operation_probabilities": operation_answer["probabilities"],
        "target_probabilities": target_answer["probabilities"] if target_answer else {},
        "raw_answers": result["answers"],
        "model": result.get("model"),
    }


def _limits(timeout, deadline):
    """post_json keyword arguments for the limits that were given (none: the demo defaults)."""
    return {name: value for name, value in (("timeout", timeout), ("deadline", deadline)) if value is not None}


def _answers(body: dict, *, key: str, limits: dict) -> dict:
    return check_provider_result(post_json(TYPESAFE_ENDPOINT, key, body, **limits))


def _ask_once(state, goal, history, elements, targets, controls, allow_blocked, *, key, limits):
    """One request to Jev: build it, send it, resolve the answer. Returns (body, result, decision)."""
    body, operations = _request(state, goal, history, elements, targets, controls, allow_blocked)
    result = _answers(body, key=key, limits=limits)
    return body, result, _resolve(result, operations, targets, controls)


def choose(state, goal, history, typed=None, allow_blocked=True, *, timeout=None, deadline=None):
    """Ask Jev for the next operation and target. `timeout` limits one request and `deadline` (time.monotonic()
    seconds) all of them together; a re-ask that does not fit before the deadline is not made and the step fails
    instead of acting on a target Jev was unsure about."""
    elements, targets, controls = action_space(state["actions"])
    # Once an input already holds the text the caller will type, typing again is pointless: do not offer it.
    if typed and any(a.get("value") == typed for a in targets.get("TYPE_TEXT", {}).values()):
        targets.pop("TYPE_TEXT")
    key = get_settings().require_typesafe_api_key()
    limits = _limits(timeout, deadline)
    started = time.perf_counter()
    body, result, decision = _ask_once(
        state, goal, history, elements, targets, controls, allow_blocked, key=key, limits=limits
    )
    usage = dict(result.get("usage") or {})
    reasked = None
    target = decision["target"]
    if target is not None and decision["target_probabilities"][target] < MIN_TARGET_PROBABILITY:
        one_call = HTTP_TIMEOUT_SECONDS if timeout is None else timeout
        if deadline is not None and deadline - time.monotonic() < one_call:
            raise RuntimeError("Jev was unsure of the target and there is no time to ask again; no action executed.")
        reasked = {"operation": decision["operation"], "target_probability": decision["target_probabilities"][target]}
        remaining = {name: found for name, found in targets.items() if name != decision["operation"]}
        body, result, decision = _ask_once(
            state, goal, history, elements, remaining, controls, allow_blocked, key=key, limits=limits
        )
        for name, value in (result.get("usage") or {}).items():
            usage[name] = usage.get(name, 0) + value
    return {
        **decision,
        "usage": usage,
        "reasked": reasked,
        "model_calls": 2 if reasked else 1,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request": body,
    }


NONE_OF_THESE = "NONE_OF_THESE"
MAX_CHOICES_PER_QUESTION = 200  # TypeSafe allows at most 255 choices in one question
BASE_MIN_PROBABILITY = 0.8  # a wrong base shows the user another item's market: pick only when Jev is sure


def pick_base(item, options, *, timeout=None, deadline=None):
    """Ask Jev for the plain item type behind `item` from a fixed list; base is None when nothing clearly fits.

    A long list is split over several questions of one request; the most probable non-NONE answer wins."""
    key = get_settings().require_typesafe_api_key()
    questions, chunks = {}, {}
    for number, start in enumerate(range(0, len(options), MAX_CHOICES_PER_QUESTION)):
        chunk = options[start : start + MAX_CHOICES_PER_QUESTION]
        criteria = {name: name for name in chunk}
        criteria[NONE_OF_THESE] = "No option is clearly the plain item type of the wanted item."
        chunks[f"base_{number}"] = list(criteria)
        questions[f"base_{number}"] = {
            "type": "choice",
            "criteria": criteria,
            "instructions": {"goal": f'Wanted item: "{item}"', "rules": BASE_PICK},
        }
    body = {"model": get_settings().typesafe_model, "state": {"wanted_item": item}, "questions": questions}
    started = time.perf_counter()
    result = _answers(body, key=key, limits=_limits(timeout, deadline))
    best, best_probability = None, 0.0
    for name, ids in chunks.items():
        answer = validate_choice(result["answers"].get(name, {}), ids)
        choice = answer["choice"]
        probability = answer["probabilities"][choice]
        if choice != NONE_OF_THESE and probability > best_probability:
            best, best_probability = choice, probability
    return {
        "base": best if best_probability >= BASE_MIN_PROBABILITY else None,
        "choice": best,
        "probability": best_probability,
        "usage": dict(result.get("usage") or {}),
        "model_calls": 1,
        "latency_ms": round((time.perf_counter() - started) * 1000),
    }
