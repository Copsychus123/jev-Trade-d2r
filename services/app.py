"""Vercel entrypoint (a WSGI application): POST /api/run/start, /api/choose and /api/run/base."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jevsvc.app import ROUTES  # noqa: E402
from jevsvc.http import wsgi  # noqa: E402


def app(environ, start_response):
    return wsgi(environ, start_response, ROUTES)
