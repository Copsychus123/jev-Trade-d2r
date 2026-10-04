"""Invite codes: creation, revocation, wrong-guess throttling and the daily quota."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from .store import hgetall

DAILY_LIMIT = 100
TAIPEI = timezone(timedelta(hours=8))
FAIL_LIMIT = 10
FAIL_WINDOW = 900


class InviteError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def code_hash(code) -> str:
    return hashlib.sha256(str(code).strip().encode("utf-8")).hexdigest()


def new_code() -> str:
    return "inv-" + secrets.token_urlsafe(16)


def _today(now: datetime) -> str:
    return now.astimezone(TAIPEI).strftime("%Y-%m-%d")


def add(store, name, *, limit=DAILY_LIMIT, expires=None) -> str:
    name = str(name).strip()
    if not name:
        raise ValueError("名字不可空白")
    if hgetall(store, f"invite_name:{name}"):
        raise ValueError("這個名字已經有邀請碼")
    code = new_code()
    fields = ("name", name, "limit", int(limit), "expires", expires or "", "disabled", "0")
    store.run("HSET", f"invite:{code_hash(code)}", *fields)
    store.run("HSET", f"invite_name:{name}", *fields, "hash", code_hash(code))
    return code


def revoke(store, name) -> None:
    record = hgetall(store, f"invite_name:{str(name).strip()}")
    if not record:
        raise ValueError("找不到這個名字")
    store.run("HSET", f"invite_name:{record['name']}", "disabled", "1")
    store.run("HSET", f"invite:{record['hash']}", "disabled", "1")


def list_invites(store, now) -> list[dict]:
    keys = store.run("SCAN", 0, "MATCH", "invite_name:*", "COUNT", 1000)[1]
    rows = []
    for key in sorted(keys):
        record = hgetall(store, key)
        used = store.run("GET", f"used:{record['hash']}:{_today(now)}")
        rows.append(
            {
                "name": record["name"],
                "limit": int(record["limit"]),
                "expires": record["expires"],
                "disabled": record["disabled"] == "1",
                "used_today": int(used or 0),
            }
        )
    return rows


def check_and_count(store, code, ip, now) -> dict:
    fail_key = f"fail:{ip}"
    if int(store.run("GET", fail_key) or 0) >= FAIL_LIMIT:
        raise InviteError(429, "錯誤次數太多，請 15 分鐘後再試")
    digest = code_hash(code)
    record = hgetall(store, f"invite:{digest}")
    if not record or record.get("disabled") == "1":
        if store.run("INCR", fail_key) == 1:
            store.run("EXPIRE", fail_key, FAIL_WINDOW)
        raise InviteError(401, "邀請碼無效或已停用")
    today = _today(now)
    if record.get("expires") and today > record["expires"]:
        raise InviteError(401, "邀請碼已過期")
    limit = int(record["limit"])
    used_key = f"used:{digest}:{today}"
    used = store.run("INCR", used_key)
    if used == 1:
        store.run("EXPIRE", used_key, 172800)
    if used > limit:
        store.run("DECR", used_key)
        raise InviteError(429, f"今天的 {limit} 次查詢已用完，台灣時間午夜 0 點重置")
    return {"hash": digest, "used": used, "limit": limit}
