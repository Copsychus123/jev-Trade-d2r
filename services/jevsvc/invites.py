"""Invite codes: creation, revocation, wrong-guess throttling, the per-code usage limit and the global pause switch.

Redis layout: one hash `invite:<sha256 of the code>` per person (name, limit, expires, disabled, used and the running
totals calls / input_tokens) and one hash `invite-names` (name -> code hash) that makes a name unique atomically."""

import hashlib
import secrets
from datetime import date, datetime, timedelta, timezone

from .store import fields_to_dict, hgetall

DEFAULT_LIMIT = 100
TAIPEI = timezone(timedelta(hours=8))
FAIL_LIMIT = 10
FAIL_WINDOW = 900
PAUSE_KEY = "paused"
NAME_INDEX = "invite-names"
DUPLICATE = "這個名字已經有邀請碼"
NOT_FOUND = "找不到這個名字"


class InviteError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def code_hash(code) -> str:
    return hashlib.sha256(str(code).strip().encode("utf-8")).hexdigest()


def record_key(digest: str) -> str:
    return f"invite:{digest}"


def new_code() -> str:
    return "inv-" + secrets.token_urlsafe(16)


def _today(now: datetime) -> str:
    return now.astimezone(TAIPEI).strftime("%Y-%m-%d")


def parse_expires(value) -> str:
    """The last valid day as 'YYYY-MM-DD' (what is stored and compared), '' for none."""
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise ValueError("到期日格式必須是 YYYY-MM-DD") from None


def _expired(expires, now) -> bool:
    if not expires:
        return False
    try:
        return _today(now) > parse_expires(expires)
    except ValueError:  # an unreadable date in the store never grants access
        return True


def check_limit(value, what="次數上限") -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{what}必須是 1 以上的整數")
    return value


def _name(value) -> str:
    name = str(value).strip()
    if not name:
        raise ValueError("名字不可空白")
    return name


def _all(store) -> list[dict]:
    """Every user record, each with its key, sorted by name. Keys that are not invite records are left out."""
    cursor, rows = "0", {}
    while True:
        cursor, keys = store.run("SCAN", cursor, "MATCH", "invite:*", "COUNT", 1000)
        if keys:
            for key, flat in zip(keys, store.pipeline([("HGETALL", key) for key in keys])):
                rows[key] = {**fields_to_dict(flat), "key": key}  # SCAN may return a key more than once
        if str(cursor) == "0":
            return sorted((r for r in rows.values() if "limit" in r), key=lambda r: r.get("name", ""))


def _find(store, name):
    name = str(name).strip()
    digest = store.run("HGET", NAME_INDEX, name)
    if digest:
        record = hgetall(store, record_key(digest))
        if "limit" in record:
            return {**record, "key": record_key(digest)}
    found = next((r for r in _all(store) if r.get("name") == name), None)
    if found:  # created before the name index existed (or the entry went stale): index it
        store.run("HSET", NAME_INDEX, name, found["key"].removeprefix("invite:"))
    return found


def _require(store, name) -> dict:
    record = _find(store, name)
    if not record:
        raise ValueError(NOT_FOUND)
    return record


def add(store, name, *, limit=DEFAULT_LIMIT, expires=None) -> str:
    name = _name(name)
    limit = check_limit(limit)
    expires = parse_expires(expires)
    if _find(store, name):
        raise ValueError(DUPLICATE)
    code = new_code()
    digest = code_hash(code)
    if not store.run("HSETNX", NAME_INDEX, name, digest):  # one atomic claim: two admins cannot both get the name
        raise ValueError(DUPLICATE)
    try:
        store.run("HSET", record_key(digest), "name", name, "limit", limit, "expires", expires, "disabled", "0")
    except Exception:
        store.run("HDEL", NAME_INDEX, name)
        raise
    return code


def revoke(store, name) -> None:
    store.run("HSET", _require(store, name)["key"], "disabled", "1")


def enable(store, name) -> None:
    store.run("HSET", _require(store, name)["key"], "disabled", "0")


def topup(store, name, amount) -> int:
    """Raise the total number of queries by `amount`; returns the new limit."""
    amount = check_limit(amount, "增加的次數")
    return int(store.run("HINCRBY", _require(store, name)["key"], "limit", amount))


def reissue(store, name) -> str:
    """A new code for the same person (the old one stops working at once); limit, usage and state carry over."""
    record = _require(store, name)
    code = new_code()
    digest = code_hash(code)
    fields = [part for field, value in record.items() if field != "key" for part in (field, value)]
    store.run("HSET", record_key(digest), *fields)  # the new record first: a failure leaves the old code valid
    store.run("HSET", NAME_INDEX, record["name"], digest)
    store.run("DEL", record["key"])
    return code


def delete(store, name) -> None:
    record = _require(store, name)
    store.run("DEL", record["key"])
    store.run("HDEL", NAME_INDEX, record["name"])


def _count(record: dict, field: str) -> int:
    """A stored counter as an int: a missing or unreadable value reads as 0."""
    return int(record.get(field) or 0)


def list_invites(store) -> list[dict]:
    return [
        {
            "name": r.get("name", ""),
            "limit": _count(r, "limit"),
            "expires": r.get("expires", ""),
            "disabled": r.get("disabled") == "1",
            "used": _count(r, "used"),
            "calls": _count(r, "calls"),
            "input_tokens": _count(r, "input_tokens"),
        }
        for r in _all(store)
    ]


def set_paused(store, paused: bool) -> None:
    if paused:
        store.run("SET", PAUSE_KEY, "1")
    else:
        store.run("DEL", PAUSE_KEY)


def usage_commands(digest: str, calls: int, input_tokens: int) -> list[tuple]:
    """Commands that add one request's Jev calls and input tokens to the person's running totals."""
    key = record_key(digest)
    return [("HINCRBY", key, "calls", calls), ("HINCRBY", key, "input_tokens", input_tokens)]


def check_and_count(store, code, caller, now) -> dict:
    """Count one use of `code` for `caller` (the hashed throttle key from `client_key`), or refuse it."""
    fail_key = f"fail:{caller}"
    digest = code_hash(code)
    key = record_key(digest)
    fails, flat = store.pipeline([("GET", fail_key), ("HGETALL", key)])
    if int(fails or 0) >= FAIL_LIMIT:
        raise InviteError(429, "錯誤次數太多，請 15 分鐘後再試", "too_many_failures")
    record = fields_to_dict(flat)
    if "limit" not in record or record.get("disabled") == "1":
        # One transaction: a failure between the two commands must not leave a counter that never expires.
        store.pipeline([("INCR", fail_key), ("EXPIRE", fail_key, FAIL_WINDOW, "NX")], atomic=True)
        raise InviteError(401, "邀請碼無效或已停用", "invite_invalid")
    if _expired(record.get("expires"), now):
        raise InviteError(401, "邀請碼已過期", "invite_expired")
    limit = int(record["limit"])
    used = store.run("HINCRBY", key, "used", 1)
    if used > limit:
        store.run("HINCRBY", key, "used", -1)
        raise InviteError(429, f"這組邀請碼的 {limit} 次查詢已用完", "invite_used_up")
    return {"hash": digest, "used": used, "limit": limit}
