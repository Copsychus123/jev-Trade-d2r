"""Vercel entrypoint (a WSGI application): POST /api/run/start and POST /api/choose."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jevsvc import app as service  # noqa: E402
from jevsvc.http import wsgi  # noqa: E402

ROUTES = {
    "/api/run/start": service.run_start,
    "/api/choose": service.choose_route,
    "/api/run/base": service.pick_base_route,
}


def app(environ, start_response):
    return wsgi(environ, start_response, ROUTES)
