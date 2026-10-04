"""Request handling for the two endpoints. Pure functions: easy to test, no HTTP in here."""

import uuid

import httpx

from jev_ultrafast import model
from jev_ultrafast.traderie.site import (
    LOAD_MORE_LIMIT,
    build_goal,
    clean_item_name,
    phase_plan,
    traderie_scope_reason,
    validate_load_more,
)

from . import invites, tokens

MAX_ITEM_CHARS = 200
MAX_MODEL_CALLS = 30
MAX_TEXT = 6000
MAX_ACTIONS = 260
MAX_HISTORY = 120
PHASES = ("trading", "recent_trades")
BAD_PAGE = "頁面資料格式錯誤"


def _error(status, message):
    return status, {"error": message}


def run_start(body, ip, store, secret, now):
    if not isinstance(body, dict):
        return _error(400, "請求格式錯誤")
    raw = body.get("item_name")
    try:
        item = clean_item_name(raw if isinstance(raw, str) else "")
    except ValueError:
        return _error(400, "請輸入裝備名稱")
    if len(item) > MAX_ITEM_CHARS:
        return _error(400, "裝備名稱太長")
    try:
        load_more = validate_load_more(body.get("load_more", LOAD_MORE_LIMIT))
    except ValueError as exc:
        return _error(400, str(exc))
    invite = body.get("invite")
    found = invites.check_and_count(store, invite if isinstance(invite, str) else "", ip, now)
    payload = {
        "rid": uuid.uuid4().hex,
        "inv": found["hash"][:12],
        "item": item,
        "lm": load_more,
        "exp": int(now.timestamp()) + tokens.RUN_SECONDS,
    }
    print(f"start inv={payload['inv']} used={found['used']}", flush=True)
    return 200, {
        "run_token": tokens.sign(secret, payload),
        "item_name": item,
        "load_more": load_more,
        "used": found["used"],
        "limit": found["limit"],
    }


def _valid_page(page, history) -> bool:
    if not isinstance(page, dict) or not isinstance(history, list):
        return False
    if not isinstance(page.get("url"), str) or not isinstance(page.get("title"), str):
        return False
    if not isinstance(page.get("text"), str) or len(page["text"]) > MAX_TEXT:
        return False
    actions = page.get("actions")
    if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        return False
    return len(history) <= MAX_HISTORY and all(isinstance(h, dict) for h in history)


def choose_step(body, store, secret, now, chooser=None):
    if not isinstance(body, dict):
        return _error(400, "請求格式錯誤")
    claims = tokens.verify(secret, body.get("run_token"), now.timestamp())
    phase, page, history = body.get("phase"), body.get("page"), body.get("history", [])
    if phase not in PHASES or not _valid_page(page, history):
        return _error(400, BAD_PAGE)
    reason = traderie_scope_reason(page["url"])
    if reason:
        return _error(400, f"超出範圍：{reason}")
    # run:{rid} counts model calls. A request may cost two (re-ask), so it is admitted only while two more still
    # fit under the limit: a run never makes more than MAX_MODEL_CALLS calls.
    run_key = f"run:{claims['rid']}"
    calls = store.run("INCR", run_key)
    if calls == 1:
        store.run("EXPIRE", run_key, tokens.RUN_SECONDS)
    if calls + 1 > MAX_MODEL_CALLS:
        return _error(429, f"這次查詢的 Jev 呼叫次數已達上限（{MAX_MODEL_CALLS} 次），請重新開始")
    goal = phase_plan(build_goal(claims["item"], claims["lm"]))[0][PHASES.index(phase)]
    try:
        # A client that saw a results page it is sure about asks again without the BLOCKED option.
        extra = {"allow_blocked": False} if body.get("no_block") is True else {}
        decision = (chooser or model.choose)(page, goal, history, claims["item"], **extra)
    except (KeyError, TypeError):
        return _error(400, BAD_PAGE)
    except (RuntimeError, ValueError, TimeoutError, httpx.HTTPError):
        return _error(502, "Jev 暫時無法回應，這一步沒有執行，請重新開始查詢")
    for _ in range(max(0, int(decision.get("model_calls") or 1) - 1)):
        store.run("INCR", run_key)
    usage = decision.get("usage") or {}
    print(
        f"choose inv={claims['inv']} rid={claims['rid'][:8]} calls={decision.get('model_calls')} "
        f"in={usage.get('input_tokens')} out={usage.get('output_tokens')}",
        flush=True,
    )
    return 200, {k: v for k, v in decision.items() if k not in ("request", "raw_answers")}


def choose_route(body, ip, store, secret, now):
    """Route signature shared with run_start; the IP does not matter once a run token exists."""
    return choose_step(body, store, secret, now)


MAX_BASE_OPTIONS = 800
MAX_BASE_NAME = 80


def pick_base_step(body, store, secret, now, picker=None):
    """Jev picks the plain item type behind the wanted item from the client's fixed list (or none of them).

    Counts as one model call of the same run. A pick returns a new run token for the base name, same run id and
    expiry, so later choose calls get a goal for the base and share the call limit. When the client already matched
    the base itself it sends `base`: no model call, same new token."""
    if not isinstance(body, dict):
        return _error(400, "請求格式錯誤")
    claims = tokens.verify(secret, body.get("run_token"), now.timestamp())
    options = body.get("options")
    if (
        not isinstance(options, list)
        or not 0 < len(options) <= MAX_BASE_OPTIONS
        or not all(isinstance(o, str) and 0 < len(o) <= MAX_BASE_NAME for o in options)
        or len(set(options)) != len(options)
    ):
        return _error(400, "底材清單格式錯誤")
    given = body.get("base")
    if given is not None:
        # The client matched the base itself (no model call): same token swap, only if it is on the list.
        if given not in options:
            return _error(400, "底材不在清單裡")
        return 200, {
            "base": given,
            "probability": None,
            "usage": {},
            "item_name": given,
            "run_token": tokens.sign(secret, {**claims, "item": given}),
        }
    run_key = f"run:{claims['rid']}"
    calls = store.run("INCR", run_key)
    if calls == 1:
        store.run("EXPIRE", run_key, tokens.RUN_SECONDS)
    if calls > MAX_MODEL_CALLS:
        return _error(429, f"這次查詢的 Jev 呼叫次數已達上限（{MAX_MODEL_CALLS} 次），請重新開始")
    try:
        picked = (picker or model.pick_base)(claims["item"], options)
    except (KeyError, TypeError):
        return _error(400, BAD_PAGE)
    except (RuntimeError, ValueError, TimeoutError, httpx.HTTPError):
        return _error(502, "Jev 暫時無法回應，請重新開始查詢")
    base = picked.get("base")
    if base not in options:
        base = None
    usage = picked.get("usage") or {}
    print(
        f"base inv={claims['inv']} rid={claims['rid'][:8]} picked={base is not None} "
        f"in={usage.get('input_tokens')} out={usage.get('output_tokens')}",
        flush=True,
    )
    reply = {"base": base, "probability": picked.get("probability"), "usage": usage}
    if base is not None:
        reply["item_name"] = base
        reply["run_token"] = tokens.sign(secret, {**claims, "item": base})
    return 200, reply


def pick_base_route(body, ip, store, secret, now):
    return pick_base_step(body, store, secret, now)
