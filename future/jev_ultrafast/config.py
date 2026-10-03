"""Centralized configuration, settings dataclass, and .env utilities."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, MutableMapping

from jev_ultrafast import fs

TRADERIE_LATEST_DIR = Path("artifacts") / "traderie" / "latest"

MAX_STEPS = 60
TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
HTTP_TIMEOUT_SECONDS = 25
IPC_CONNECT_TIMEOUT_SECONDS = 30.0
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


def get_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Construct a fresh Settings instance from environment variables."""
    env = os.environ if environ is None else environ

    def get_clean(key: str, default: str | None = None) -> str | None:
        val = env.get(key)
        if val is None:
            return default
        s = val.strip()
        return s if s else default

    port_raw = get_clean("TYPESAFE_DEMO_PORT")
    if port_raw is not None:
        try:
            demo_port = int(port_raw)
        except ValueError as exc:
            raise ValueError("TYPESAFE_DEMO_PORT must be an integer") from exc
    else:
        demo_port = 8766

    retry_count_raw = get_clean("API_RETRY_COUNT")
    if retry_count_raw is not None:
        try:
            api_retry_count = int(retry_count_raw)
        except ValueError as exc:
            raise ValueError("API_RETRY_COUNT must be an integer") from exc
    else:
        api_retry_count = 3

    initial_delay_raw = get_clean("API_INITIAL_RETRY_DELAY_SECONDS")
    if initial_delay_raw is not None:
        try:
            api_initial_retry_delay_seconds = float(initial_delay_raw)
        except ValueError as exc:
            raise ValueError("API_INITIAL_RETRY_DELAY_SECONDS must be a number") from exc
    else:
        api_initial_retry_delay_seconds = 0.5

    max_delay_raw = get_clean("API_MAX_RETRY_DELAY_SECONDS")
    if max_delay_raw is not None:
        try:
            api_max_retry_delay_seconds = float(max_delay_raw)
        except ValueError as exc:
            raise ValueError("API_MAX_RETRY_DELAY_SECONDS must be a number") from exc
    else:
        api_max_retry_delay_seconds = 16.0

    def price(key: str, default: float) -> float:
        raw = get_clean(key)
        if raw is None:
            return default
        try:
            value = float(raw)
        except ValueError as exc:
            raise ValueError(f"{key} must be a number") from exc
        if value < 0:
            raise ValueError(f"{key} must not be negative")
        return value

    return Settings(
        typesafe_api_key=get_clean("TYPESAFE_API_KEY"),
        typesafe_model=get_clean("TYPESAFE_MODEL", "jev-latest") or "jev-latest",
        demo_port=demo_port,
        traderie_cookie=get_clean("TRADERIE_COOKIE", "") or "",
        traderie_session_token=get_clean("TRADERIE_SESSION_TOKEN", "") or "",
        traderie_session_cookie_name=get_clean("TRADERIE_SESSION_COOKIE_NAME", "session") or "session",
        api_retry_count=api_retry_count,
        api_initial_retry_delay_seconds=api_initial_retry_delay_seconds,
        api_max_retry_delay_seconds=api_max_retry_delay_seconds,
        jev_input_usd_per_million=price("JEV_INPUT_USD_PER_MILLION", 0.042),
        jev_output_usd_per_million=price("JEV_OUTPUT_USD_PER_MILLION", 0.0),
    )


def load_dotenv(path: Path | str | None = None, environ: MutableMapping[str, str] | None = None) -> bool:
    """Populate os.environ from a dotenv file using setdefault; real env wins."""
    target = Path(path) if path is not None else Path.cwd() / DOTENV_NAME
    if not target.exists():
        return False
    env = os.environ if environ is None else environ
    content = fs.read_text(target)
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, val = stripped.split("=", 1)
        k = key.strip()
        v = val.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        env.setdefault(k, v)
    return True
