"""Centralized configuration, settings dataclass, and .env utilities."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, MutableMapping

EXPORT_PREFIX = re.compile(r"^export\s+")
TRADERIE_LATEST_DIR = Path("artifacts") / "traderie" / "latest"

MAX_STEPS = 60
TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
HTTP_TIMEOUT_SECONDS = 25
VIEWPORT_WIDTH = 1120
VIEWPORT_HEIGHT = 780
DEMO_HOST = "127.0.0.1"
DOTENV_NAME = ".env"


@dataclass(frozen=True)
class Settings:
    """Immutable application settings resolved from the environment."""

    typesafe_api_key: str | None = None
    typesafe_model: str = "jev-latest"
    demo_port: int = 8766
    traderie_cookie: str = ""
    traderie_session_token: str = ""
    traderie_session_cookie_name: str = "session"
    api_retry_count: int = 3
    api_initial_retry_delay_seconds: float = 0.5
    api_max_retry_delay_seconds: float = 16.0
    # Published TypeSafe card for jev-latest: input 0.042 USD per million tokens, output free.
    jev_input_usd_per_million: float = 0.042
    jev_output_usd_per_million: float = 0.0

    def require_typesafe_api_key(self) -> str:
        if not self.typesafe_api_key:
            raise ValueError("TYPESAFE_API_KEY is not set")
        return self.typesafe_api_key


# The dataclass holds every default once; get_settings only overrides what the environment actually sets.
_DEFAULTS = Settings()


def get_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Construct a fresh Settings instance from environment variables."""
    env = os.environ if environ is None else environ

    def get_clean(key: str, default: str | None = None) -> str | None:
        val = env.get(key)
        if val is None:
            return default
        s = val.strip()
        return s if s else default

    def number(key: str, cast, default, kind: str):
        raw = get_clean(key)
        if raw is None:
            return default
        try:
            return cast(raw)
        except ValueError as exc:
            raise ValueError(f"{key} must be {kind}") from exc

    def price(key: str, default: float) -> float:
        value = number(key, float, default, "a number")
        if value < 0:
            raise ValueError(f"{key} must not be negative")
        return value

    return Settings(
        typesafe_api_key=get_clean("TYPESAFE_API_KEY"),
        typesafe_model=get_clean("TYPESAFE_MODEL", _DEFAULTS.typesafe_model),
        demo_port=number("TYPESAFE_DEMO_PORT", int, _DEFAULTS.demo_port, "an integer"),
        traderie_cookie=get_clean("TRADERIE_COOKIE", _DEFAULTS.traderie_cookie),
        traderie_session_token=get_clean("TRADERIE_SESSION_TOKEN", _DEFAULTS.traderie_session_token),
        traderie_session_cookie_name=get_clean("TRADERIE_SESSION_COOKIE_NAME", _DEFAULTS.traderie_session_cookie_name),
        api_retry_count=number("API_RETRY_COUNT", int, _DEFAULTS.api_retry_count, "an integer"),
        api_initial_retry_delay_seconds=number(
            "API_INITIAL_RETRY_DELAY_SECONDS", float, _DEFAULTS.api_initial_retry_delay_seconds, "a number"
        ),
        api_max_retry_delay_seconds=number(
            "API_MAX_RETRY_DELAY_SECONDS", float, _DEFAULTS.api_max_retry_delay_seconds, "a number"
        ),
        jev_input_usd_per_million=price("JEV_INPUT_USD_PER_MILLION", _DEFAULTS.jev_input_usd_per_million),
        jev_output_usd_per_million=price("JEV_OUTPUT_USD_PER_MILLION", _DEFAULTS.jev_output_usd_per_million),
    )


def load_dotenv(path: Path | str | None = None, environ: MutableMapping[str, str] | None = None) -> bool:
    """Populate os.environ from a dotenv file using setdefault; real env wins."""
    target = Path(path) if path is not None else Path.cwd() / DOTENV_NAME
    if not target.exists():
        return False
    env = os.environ if environ is None else environ
    content = target.read_text(encoding="utf-8-sig")  # a Windows editor may have saved the file with a BOM
    for line in content.splitlines():
        stripped = EXPORT_PREFIX.sub("", line.strip(), count=1)
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env.setdefault(key, value)
    return True
