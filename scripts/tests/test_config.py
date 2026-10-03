"""Unit tests for jev_ultrafast.config settings and dotenv utilities."""

from pathlib import Path

import pytest

from jev_ultrafast.config import get_settings, load_dotenv


def test_get_settings_defaults():
    s = get_settings({})
    assert s.typesafe_api_key is None
    assert s.typesafe_model == "jev-latest"
    assert s.demo_port == 8766
    assert s.traderie_cookie == ""
    assert s.traderie_session_token == ""
    assert s.traderie_session_cookie_name == "session"
    assert s.api_retry_count == 3
    assert s.api_initial_retry_delay_seconds == 0.5
    assert s.api_max_retry_delay_seconds == 16.0


def test_get_settings_env_overrides():
    env = {
        "TYPESAFE_API_KEY": "key1",
        "TYPESAFE_MODEL": "custom-model",
        "TYPESAFE_DEMO_PORT": "9000",
        "TRADERIE_COOKIE": "c1=v1",
        "TRADERIE_SESSION_TOKEN": "token123",
        "TRADERIE_SESSION_COOKIE_NAME": "auth",
        "API_RETRY_COUNT": "5",
        "API_INITIAL_RETRY_DELAY_SECONDS": "1.5",
        "API_MAX_RETRY_DELAY_SECONDS": "30.0",
    }
    s = get_settings(env)
    assert s.typesafe_api_key == "key1"
    assert s.typesafe_model == "custom-model"
    assert s.demo_port == 9000
    assert s.traderie_cookie == "c1=v1"
    assert s.traderie_session_token == "token123"
    assert s.traderie_session_cookie_name == "auth"
    assert s.api_retry_count == 5
    assert s.api_initial_retry_delay_seconds == 1.5
    assert s.api_max_retry_delay_seconds == 30.0


def test_get_settings_invalid_port_raises():
    with pytest.raises(ValueError, match="TYPESAFE_DEMO_PORT must be an integer"):
        get_settings({"TYPESAFE_DEMO_PORT": "not-a-number"})


def test_settings_require_helpers():
    s_empty = get_settings({})
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY is not set"):
        s_empty.require_typesafe_api_key()

    s_full = get_settings({"TYPESAFE_API_KEY": "k1"})
    assert s_full.require_typesafe_api_key() == "k1"


def test_load_dotenv_precedence_and_utf8(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# Comment line\n"
        "EXISTING=from_file\n"
        "NEW_KEY=café\n"
        "QUOTED_DOUBLE=\"double-quoted\"\n"
        "QUOTED_SINGLE='single-quoted'\n",
        encoding="utf-8",
    )

    env = {"EXISTING": "from_real_env"}
    loaded = load_dotenv(env_file, environ=env)
    assert loaded is True
    assert env["EXISTING"] == "from_real_env"
    assert env["NEW_KEY"] == "café"
    assert env["QUOTED_DOUBLE"] == "double-quoted"
    assert env["QUOTED_SINGLE"] == "single-quoted"

    missing = load_dotenv(tmp_path / "does_not_exist.env", environ=env)
    assert missing is False


@pytest.mark.parametrize("empty_key,empty_val", [
    ("TYPESAFE_DEMO_PORT", ""),
    ("TYPESAFE_API_KEY", ""),
])
def test_get_settings_handles_empty_null_values(empty_key, empty_val):
    """Empty/null settings values -> handled gracefully or validated with error."""
    env = {empty_key: empty_val}
    # Empty values should either use defaults or raise validation error
    settings = get_settings(env)
    assert settings is not None


@pytest.mark.parametrize("invalid_key,invalid_val,expected_err", [
    ("API_RETRY_COUNT", "not-a-number", "API_RETRY_COUNT must be an integer"),
    ("API_INITIAL_RETRY_DELAY_SECONDS", "invalid-float", "API_INITIAL_RETRY_DELAY_SECONDS must be a number"),
    ("API_MAX_RETRY_DELAY_SECONDS", "invalid-float", "API_MAX_RETRY_DELAY_SECONDS must be a number"),
])
def test_get_settings_rejects_invalid_numeric_types(invalid_key, invalid_val, expected_err):
    """Invalid numeric strings -> raises descriptive ValueError."""
    env = {invalid_key: invalid_val}
    with pytest.raises(ValueError, match=expected_err):
        get_settings(env)


def test_get_settings_handles_negative_or_extreme_numeric_ranges():
    """Negative retry count or -inf delay -> get_settings parses values without crashing."""
    settings = get_settings({
        "API_RETRY_COUNT": "-5",
        "API_INITIAL_RETRY_DELAY_SECONDS": "-1.0",
        "API_MAX_RETRY_DELAY_SECONDS": "-inf",
    })
    assert settings.api_retry_count == -5
    assert settings.api_initial_retry_delay_seconds == -1.0
    assert settings.api_max_retry_delay_seconds == float("-inf")


@pytest.mark.parametrize("port_val", [
    "0",
    "65535",
    "32768",
])
def test_get_settings_accepts_valid_port_ranges(port_val):
    """Valid port ranges -> accepted without error."""
    env = {"TYPESAFE_DEMO_PORT": port_val}
    settings = get_settings(env)
    assert settings.demo_port == int(port_val)


def test_jev_prices_default_to_the_published_card_and_can_be_overridden():
    defaults = get_settings({})
    assert defaults.jev_input_usd_per_million == 0.042
    assert defaults.jev_output_usd_per_million == 0.0
    custom = get_settings({"JEV_INPUT_USD_PER_MILLION": "0.08", "JEV_OUTPUT_USD_PER_MILLION": "0.5"})
    assert (custom.jev_input_usd_per_million, custom.jev_output_usd_per_million) == (0.08, 0.5)


@pytest.mark.parametrize("value", ["-1", "cheap"])
def test_jev_price_rejects_negative_or_non_numbers(value):
    with pytest.raises(ValueError, match="JEV_INPUT_USD_PER_MILLION"):
        get_settings({"JEV_INPUT_USD_PER_MILLION": value})
