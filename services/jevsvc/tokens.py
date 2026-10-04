"""Signed, short-lived run tokens."""

import base64
import hashlib
import hmac
import json

from .invites import InviteError

RUN_SECONDS = 1800
INVALID = "查詢已逾時或無效，請重新開始"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: str, body: str) -> str:
    return _b64(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())


def sign(secret: str, payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_mac(secret, body)}"


def verify(secret: str, token, now_ts) -> dict:
    try:
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, _mac(secret, body)):
            raise ValueError("signature")
        payload = json.loads(_unb64(body))
        if not isinstance(payload, dict) or payload["exp"] <= now_ts:
            raise ValueError("expired")
        return payload
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise InviteError(401, INVALID) from exc
