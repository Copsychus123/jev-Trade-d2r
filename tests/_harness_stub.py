"""A `browser_harness` stand-in for the offline lane, installed before the package is imported.

The real package starts the dedicated Chrome daemon and talks to it over CDP on first use; the offline lane must
never do that. The callers (`tests/test_traderie.py`, `tests/test_services.py`, `tests/test_extension_build.py`)
run `install()` before importing the package or a script that does, which is why those imports carry
`# noqa: E402`. All three names are replaced in `sys.modules` for the whole process, so a module that imported
the real `browser_harness` earlier is covered as well.
"""

import sys
import types


def install() -> None:
    """Make `browser_harness` and its `.admin` / `.helpers` modules no-ops in `sys.modules`."""
    browser_harness = types.ModuleType("browser_harness")
    admin = types.ModuleType("browser_harness.admin")
    helpers = types.ModuleType("browser_harness.helpers")
    admin.ensure_daemon = lambda: None
    helpers.cdp = lambda *args, **kwargs: {}
    helpers.drain_events = lambda: []
    browser_harness.admin = admin
    browser_harness.helpers = helpers
    sys.modules["browser_harness"] = browser_harness
    sys.modules["browser_harness.admin"] = admin
    sys.modules["browser_harness.helpers"] = helpers
