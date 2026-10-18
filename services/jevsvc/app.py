"""Request handling for the three endpoints. Pure functions: easy to test, no HTTP in here."""

import json
import os
import re
import time
import uuid

import httpx

from jev_ultrafast import model
from jev_ultrafast.traderie.site import (
    LOAD_MORE_LIMIT,
    VIEW_NAMES,
    build_goal,
    clean_item_name,
    phase_plan,
    traderie_scope_reason,
    validate_load_more,
)

from . import bases, invites, tokens
from .http import BAD_REQUEST, NOT_CONFIGURED
from .store import StoreError

MAX_ITEM_CHARS = 200
MAX_MODEL_CALLS = 30
MAX_URL = 2000
MAX_TITLE = 500
MAX_TEXT = 6000
MAX_ACTIONS = 260
# The page does not cap an accessible name or an input's value, so these are cut (not rejected): they cost tokens
# and the model gains nothing from more.
MAX_LABEL = 200
MAX_VALUE = 200
MAX_HISTORY_TEXT = 200
MAX_FIELD = 40  # ids, kinds, node ids, roles and state strings are short by nature: longer means not ours
MAX_HISTORY = 60  # the extension stops a run after 60 actions
BAD_PAGE = "頁面資料格式錯誤"
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

# Vercel stops a function after `maxDuration` (60 s, services/vercel.json). All Jev requests of one step share a budget
# well under that, so the answer (or a clean error) always gets out in time.
CALL_TIMEOUT = 12.0
REQUEST_BUDGET = 45.0

BASES = bases.load()

# The failures a Jev step can raise: an unavailable model (502), never the client's own mistake (400).
MODEL_ERRORS = (RuntimeError, ValueError, TimeoutError, httpx.HTTPError)


def _error(status, error, code):
    return status, {"error": error, "code": code}


def _brief(exc) -> str:
    """Exception type and a short one-line message for the log: never a request body, never the key."""
    text = " ".join(str(exc).split())
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        text = text.replace(key, "***")
    return f"{type(exc).__name__}: {text[:200]}"


def _model_configured() -> bool:
    return bool(os.environ.get("TYPESAFE_API_KEY", "").strip())


def _clean_item(raw) -> str:
    """The item name as it may enter the goal: one trimmed line, bounded, without control characters or quotes."""
    try:
        item = clean_item_name(raw if isinstance(raw, str) else "")
    except ValueError:
        raise ValueError("請輸入裝備名稱") from None
    if len(item) > MAX_ITEM_CHARS:
        raise ValueError("裝備名稱太長")
    if not bases.is_goal_safe(item):
        raise ValueError("裝備名稱含有不允許的字元")
    return item


def _start_reply(secret, payload, used, limit):
    return {
        "run_token": tokens.sign(secret, payload),
        "item_name": payload["item"],
        "load_more": payload["lm"],
        "used": used,
        "limit": limit,
    }


def _remembered_start(store, saved_key, secret):
    """The answer a repeated start already got (same request_id), or None when there is none to replay."""
    remembered = store.run("GET", saved_key) if saved_key else None
    if not remembered:
        return None
    try:
        payload, used, limit = json.loads(remembered)
        return 200, _start_reply(secret, payload, used, limit)
    except (ValueError, TypeError, KeyError):
        return None  # unreadable: start again


def run_start(body, caller, store, secret, now):
    if refusal := _refuse_non_object(body):
        return refusal
    try:
        item = _clean_item(body.get("item_name"))
    except ValueError as exc:
        return _error(400, str(exc), "bad_item")
    try:
        load_more = validate_load_more(body.get("load_more", LOAD_MORE_LIMIT))
    except ValueError as exc:
        return _error(400, str(exc), "bad_load_more")
    request_id = body.get("request_id")
    if request_id is not None and not (isinstance(request_id, str) and REQUEST_ID.match(request_id)):
        return _error(400, **BAD_REQUEST)
    invite = body.get("invite")
    invite = invite if isinstance(invite, str) else ""
    # A client that repeats a start it never got an answer for (same request_id) gets the same answer, uncounted.
    # This returns before the invite checks on purpose: the reply is the token already signed for that rid, so it
    # shares that run's own 30-call budget and cannot multiply it. The consequence is that revoke, disable and pause
    # are not immediate for a start that already happened -- which is true of an issued token anyway, since it lives
    # until its own expiry. A security pass (2026-10) raised closing that gap on this path; the owner kept it as is.
    saved_key = None if request_id is None else f"start:{invites.code_hash(invite)}:{request_id}"
    if reply := _remembered_start(store, saved_key, secret):
        return reply
    invite_record = invites.check_and_count(store, invite, caller, now)
    payload = {
        "rid": uuid.uuid4().hex,
        "inv": invite_record["hash"],
        "item": item,
        "lm": load_more,
        "exp": int(now.timestamp()) + tokens.RUN_SECONDS,
    }
    if saved_key:
        remembered = json.dumps([payload, invite_record["used"], invite_record["limit"]])
        try:
            store.run("SET", saved_key, remembered, "EX", tokens.RUN_SECONDS)
        except StoreError as exc:  # the use is already counted: answer anyway
            print(f"start not remembered: {exc}", flush=True)
    print(f"start inv={invite_record['hash'][:12]} used={invite_record['used']}", flush=True)
    return 200, _start_reply(secret, payload, invite_record["used"], invite_record["limit"])


def _text(value, limit, *, cut=True):
    """`value` cut to `limit` characters; None when it is not a string, or is too long and may not be cut."""
    if not isinstance(value, str) or (len(value) > limit and not cut):
        return None
    return value[:limit]


_ACTION_KEYS = (
    # (key, limit, cut): the short keys are refused when too long, `value`/`current_value` are cut down instead.
    ("role", MAX_FIELD, False),
    ("checked", MAX_FIELD, False),
    ("selected", MAX_FIELD, False),
    ("expanded", MAX_FIELD, False),
    ("value", MAX_VALUE, True),
    ("current_value", MAX_VALUE, True),
)


def _clean_action(action):
    """The keys action_space reads, typed and bounded; None when the action is not usable. Everything else the page
    sent (rect, delta, ...) is dropped."""
    if not isinstance(action, dict):
        return None
    kind = _text(action.get("kind"), MAX_FIELD, cut=False)
    ident = _text(action.get("id"), MAX_FIELD, cut=False)
    label = _text(action.get("label"), MAX_LABEL)
    if not kind or not ident or label is None:
        return None
    clean = {"kind": kind, "id": ident, "label": label}
    if kind in ("click", "fill", "select"):
        node = action.get("node")
        if type(node) is not int and _text(node, MAX_FIELD, cut=False) is None:
            return None
        clean["node"] = node
    for key, limit, cut in _ACTION_KEYS:
        if key not in action:
            continue
        value = _text(action[key], limit, cut=cut)
        if value is None:
            return None
        clean[key] = value
    if kind == "select" and "value" not in clean:
        return None
    return clean


def _clean_page(page):
    if not isinstance(page, dict):
        return None
    url = _text(page.get("url"), MAX_URL, cut=False)
    title = _text(page.get("title"), MAX_TITLE, cut=False)
    text = _text(page.get("text"), MAX_TEXT, cut=False)
    actions = page.get("actions")
    if url is None or title is None or text is None or not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        return None
    clean = [_clean_action(a) for a in actions]
    if any(a is None for a in clean):
        return None
    return {"url": url, "title": title, "text": text, "actions": clean}


def _clean_history(history):
    """Only what the request to Jev reads (action, kind, text, page_changed), typed and bounded."""
    if not isinstance(history, list) or len(history) > MAX_HISTORY:
        return None
    limits = {"action": MAX_LABEL, "kind": MAX_FIELD, "text": MAX_HISTORY_TEXT}
    clean = []
    for entry in history:
        if not isinstance(entry, dict):
            return None
        cleaned = {}
        for key, limit in limits.items():
            value = entry.get(key)
            if value is None:  # an absent field, or an explicit None, is simply left out
                continue
            text = _text(value, limit)
            if text is None:
                return None
            cleaned[key] = text
        changed = entry.get("page_changed")
        if changed is not None:
            if not isinstance(changed, bool):
                return None
            cleaned["page_changed"] = changed
        clean.append(cleaned)
    return clean


def _claims(payload):
    """A correctly signed token that does not carry what this version needs (an older token) is just invalid."""
    try:
        validate_load_more(payload.get("lm"))
    except ValueError:
        raise invites.InviteError(401, tokens.INVALID, "token_invalid") from None
    if not all(isinstance(payload.get(key), str) and payload[key] for key in ("rid", "inv", "item")):
        raise invites.InviteError(401, tokens.INVALID, "token_invalid")
    return payload


def _reserve(store, run_key, slots) -> bool:
    """Take `slots` Jev calls of the run's budget in one atomic step (the counter and its lifetime together).
    False, with nothing taken, when they do not fit under MAX_MODEL_CALLS."""
    total, _ = store.pipeline(
        [("INCRBY", run_key, slots), ("EXPIRE", run_key, tokens.RUN_SECONDS, "NX")], atomic=True
    )
    if total > MAX_MODEL_CALLS:
        store.run("DECRBY", run_key, slots)
        return False
    return True


def _after_success(store, claims, run_key, *, spare, calls, usage):
    """Hand back the reserved call(s) that were not needed, add to the person's totals and mark the run as answered.
    The answer is already in hand, so a store failure here is logged and never turned into an error response."""
    tokens_in = usage.get("input_tokens")
    tokens_in = int(tokens_in) if isinstance(tokens_in, (int, float)) else 0
    commands = [("SET", f"ok:{claims['rid']}", "1", "EX", tokens.RUN_SECONDS)]
    if spare:
        commands.append(("DECRBY", run_key, spare))
    if len(claims["inv"]) == 64:  # tokens of an older version carry only a log prefix: no record to add to
        commands += invites.usage_commands(claims["inv"], calls, tokens_in)
    try:
        store.pipeline(commands)
    except StoreError as exc:
        print(f"usage not recorded: {exc}", flush=True)


def _after_failure(store, claims, run_key, *, spare=1):
    """Keep the attempt's own reserved call and hand `spare` back. If this run never got a single answer, the start
    use it cost is given back too, once: nobody pays for Jev being down."""
    rid = claims["rid"]
    commands = [("GET", f"ok:{rid}")]
    if spare:
        commands.append(("DECRBY", run_key, spare))
    commands.append(("SET", f"refund:{rid}", "1", "NX", "EX", tokens.RUN_SECONDS))
    try:
        results = store.pipeline(commands)
        # The GET is first, the SET that claims the refund is always last.
        was_answered, claimed = results[0], results[-1]
        record = invites.record_key(claims["inv"])
        if (
            was_answered is None
            and claimed == "OK"
            and len(claims["inv"]) == 64
            and store.run("HEXISTS", record, "limit")
        ):
            store.run("HINCRBY", record, "used", -1)
    except StoreError as exc:
        print(f"failed step not settled: {exc}", flush=True)


def _model_unavailable(store, claims, run_key, exc, *, stage, message, spare=1):
    """The refusal for a Jev step the model could not answer: log it, settle the attempt's cost, then 502."""
    print(f"{stage} failed {_who(claims)} {_brief(exc)}", flush=True)
    _after_failure(store, claims, run_key, spare=spare)
    return _error(502, message, "model_unavailable")


def _refuse_non_object(body):
    """The refusal for a request body that is not an object, or None when it is one."""
    if not isinstance(body, dict):
        return _error(400, **BAD_REQUEST)
    return None


def _step_claims(body, secret, now):
    """The request deadline and the verified run token every Jev step starts from."""
    deadline = time.monotonic() + REQUEST_BUDGET
    claims = _claims(tokens.verify(secret, body.get("run_token"), now.timestamp()))
    return deadline, claims


def _who(claims) -> str:
    """The who of one Jev log line: the invitation and run ids, shortened."""
    return f"inv={claims['inv'][:12]} rid={claims['rid'][:8]}"


def _log_usage(stage, claims, usage, extra=""):
    """One line per answered Jev step: who, which stage, and what it cost."""
    print(
        f"{stage} {_who(claims)}{extra} in={usage.get('input_tokens')} out={usage.get('output_tokens')}",
        flush=True,
    )


def _reserve_call_budget(store, claims, count, override=None):
    """The run's call key once the model key is configured and `count` Jev calls are reserved, else the refusal."""
    if override is None and not _model_configured():
        print("missing env: TYPESAFE_API_KEY", flush=True)
        return None, _error(500, **NOT_CONFIGURED)
    run_key = f"run:{claims['rid']}"
    if _reserve(store, run_key, count):
        return run_key, None
    msg = f"這次查詢的 Jev 呼叫次數已達上限（{MAX_MODEL_CALLS} 次），請重新開始"
    return run_key, _error(429, msg, "call_limit")


def choose_step(body, store, secret, now, chooser=None):
    if refusal := _refuse_non_object(body):
        return refusal
    deadline, claims = _step_claims(body, secret, now)
    phase = body.get("phase")
    page = _clean_page(body.get("page"))
    history = _clean_history(body.get("history", []))
    if phase not in VIEW_NAMES or page is None or history is None:
        return _error(400, BAD_PAGE, "bad_page")
    reason = traderie_scope_reason(page["url"])
    if reason:
        return _error(400, f"超出範圍：{reason}", "out_of_scope")
    try:
        # The one place a page of the wrong shape can fail. After this, errors are ours or Jev's, never the client's.
        model.action_space(page["actions"])
    except (KeyError, TypeError, ValueError, AttributeError):
        return _error(400, BAD_PAGE, "bad_page")
    # run:{rid} counts model calls. A request may cost two (re-ask), so both are reserved up front and one is handed
    # back when it was not needed: a run never makes more than MAX_MODEL_CALLS calls.
    run_key, refusal = _reserve_call_budget(store, claims, 2, chooser)
    if refusal:
        return refusal
    try:
        goal = phase_plan(build_goal(claims["item"], claims["lm"]))[0][VIEW_NAMES.index(phase)]
        # A client that saw a results page it is sure about asks again without the BLOCKED option.
        extra = {"allow_blocked": False} if body.get("no_block") is True else {}
        decision = (chooser or model.choose)(
            page, goal, history, claims["item"], timeout=CALL_TIMEOUT, deadline=deadline, **extra
        )
    except MODEL_ERRORS as exc:
        return _model_unavailable(
            store, claims, run_key, exc, stage="choose", message="Jev 暫時無法回應，這一步沒有執行，請重新開始查詢"
        )
    calls = min(2, max(1, int(decision.get("model_calls") or 1)))
    usage = decision.get("usage") or {}
    _after_success(store, claims, run_key, spare=2 - calls, calls=calls, usage=usage)
    _log_usage("choose", claims, usage, f" calls={calls}")
    return 200, {k: v for k, v in decision.items() if k not in ("request", "raw_answers")}


def choose_route(body, caller, store, secret, now):
    """Route signature shared with run_start; the IP does not matter once a run token exists."""
    return choose_step(body, store, secret, now)


def _base_reply(secret, claims, base, probability, usage):
    reply = {"base": base, "probability": probability, "usage": usage}
    if base is not None:
        reply["item_name"] = base
        reply["run_token"] = tokens.sign(secret, {**claims, "item": base})
    return reply


def pick_base_step(body, store, secret, now, picker=None):
    """Jev picks the plain item type behind the wanted item from the server's fixed list (or none of them). A list
    in the request is ignored: the client does not get to decide what Jev may choose from.

    Counts as one model call of the same run; a failed pick settles exactly like a failed choose (that one call stays
    as the attempt's cost, and the run's start use comes back when the run never got an answer). A pick returns a new
    run token for the base name, same run id and expiry, so later choose calls get a goal for the base and share the
    call limit. When the client already matched the base itself it sends `base`: no model call, same new token, only if
    it is on the list."""
    if refusal := _refuse_non_object(body):
        return refusal
    deadline, claims = _step_claims(body, secret, now)
    given = body.get("base")
    if given is not None:
        if not isinstance(given, str) or given not in BASES:
            return _error(400, "底材不在清單裡", "bad_base")
        return 200, _base_reply(secret, claims, given, None, {})
    run_key, refusal = _reserve_call_budget(store, claims, 1, picker)
    if refusal:
        return refusal
    try:
        picked = (picker or model.pick_base)(claims["item"], list(BASES), timeout=CALL_TIMEOUT, deadline=deadline)
    except MODEL_ERRORS as exc:
        return _model_unavailable(
            # the one reserved call is this attempt's cost
            store, claims, run_key, exc, stage="base", message="Jev 暫時無法回應，請重新開始查詢", spare=0
        )
    base = picked.get("base")
    if base not in BASES:
        base = None
    usage = picked.get("usage") or {}
    _after_success(store, claims, run_key, spare=0, calls=1, usage=usage)
    _log_usage("base", claims, usage, f" picked={base is not None}")
    return 200, _base_reply(secret, claims, base, picked.get("probability"), usage)


def pick_base_route(body, caller, store, secret, now):
    return pick_base_step(body, store, secret, now)


ROUTES = {
    "/api/run/start": run_start,
    "/api/choose": choose_route,
    "/api/run/base": pick_base_route,
}
