"""TypeSafe makes choices; an optional small OpenAI-compatible model writes field values."""

import json
import logging
import math
import random
import time
from collections import Counter

import httpx

from .config import HTTP_TIMEOUT_SECONDS, TYPESAFE_ENDPOINT, get_settings
from .questions import NEXT_ACTION, TARGET

logger = logging.getLogger(__name__)

CLIENT = httpx.Client(timeout=HTTP_TIMEOUT_SECONDS)


def post_json(url, key, body):
    settings = get_settings()
    max_retries = max(1, settings.api_retry_count)
    initial_delay = settings.api_initial_retry_delay_seconds
    max_delay = settings.api_max_retry_delay_seconds

    attempts: list[str] = []
    for attempt in range(max_retries):
        try:
            response = CLIENT.post(url, json=body, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError as exc:
            attempts.append(f"attempt {attempt + 1}: network error ({exc})")
            if attempt < max_retries - 1:
                delay = min(initial_delay * (2**attempt), max_delay)
                sleep_delay = delay * (1 + random.uniform(0, 0.1))
                time.sleep(sleep_delay)
                continue
            raise RuntimeError(
                f"Model connection failed after {max_retries} attempts: {'; '.join(attempts)}"
            ) from None

        if response.status_code in {429, 529, 503}:
            attempts.append(f"attempt {attempt + 1}: HTTP {response.status_code}")
            if attempt < max_retries - 1:
                delay = min(initial_delay * (2**attempt), max_delay)
                sleep_delay = delay * (1 + random.uniform(0, 0.1))
                time.sleep(sleep_delay)
                continue
            break

        if response.is_error:
            raise RuntimeError(f"Model provider returned HTTP {response.status_code}; no action executed.")

        try:
            return response.json()
        except json.JSONDecodeError as exc:
            try:
                preview = response.text[:200] if hasattr(response, "text") and response.text else ""
            except Exception:
                preview = ""
            raise ValueError(
                f"Failed to parse JSON response from model provider (HTTP {response.status_code}): {preview}"
            ) from exc
        except (httpx.TimeoutException, TimeoutError) as exc:
            logger.error("Network timeout during json() call: %s", exc)
            raise

    raise RuntimeError(f"Model unavailable after {max_retries} attempts: {'; '.join(attempts)}")


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
    except (KeyError, TypeError, ValueError):
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


def _request(state, goal, history, elements, targets, controls):
    labels = {
        "CLICK": "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
        "SELECT": "Select an observed dropdown value.",
    }
    operations = {key: labels[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(DONE="Every requirement is visibly satisfied.", BLOCKED="No supported operation can progress.")
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
        "model": result["model"],
    }


def choose(state, goal, history, typed=None):
    elements, targets, controls = action_space(state["actions"])
    # Once an input already holds the text the caller will type, typing again is pointless: do not offer it.
    if typed and any(a.get("value") == typed for a in targets.get("TYPE_TEXT", {}).values()):
        targets.pop("TYPE_TEXT")
    key = get_settings().require_typesafe_api_key()
    started = time.perf_counter()
    body, operations = _request(state, goal, history, elements, targets, controls)
    result = post_json(TYPESAFE_ENDPOINT, key, body)
    decision = _resolve(result, operations, targets, controls)
    usage = dict(result.get("usage", {}))
    reasked = None
    target = decision["target"]
    if target is not None and decision["target_probabilities"][target] < MIN_TARGET_PROBABILITY:
        reasked = {"operation": decision["operation"], "target_probability": decision["target_probabilities"][target]}
        remaining = {name: found for name, found in targets.items() if name != decision["operation"]}
        body, operations = _request(state, goal, history, elements, remaining, controls)
        result = post_json(TYPESAFE_ENDPOINT, key, body)
        decision = _resolve(result, operations, remaining, controls)
        for name, value in result.get("usage", {}).items():
            usage[name] = usage.get(name, 0) + value
    return {
        **decision,
        "usage": usage,
        "reasked": reasked,
        "model_calls": 2 if reasked else 1,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request": body,
    }
