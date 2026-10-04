"""Redis access: Upstash REST in production, an in-memory stand-in for tests and local dev."""

import fnmatch
from typing import Any

import httpx


class StoreError(RuntimeError):
    pass


class Store:
    def __init__(self, url: str, token: str):
        self.url = url
        self.token = token
        self.client = httpx.Client(timeout=10)

    def run(self, *command) -> Any:
        try:
            response = self.client.post(
                self.url,
                json=[str(c) for c in command],
                headers={"Authorization": f"Bearer {self.token}"},
            )
        except httpx.HTTPError as exc:
            raise StoreError(f"store unreachable: {type(exc).__name__}") from exc
        try:
            body = response.json()
        except ValueError:
            body = {}
        if not response.is_success or (isinstance(body, dict) and "error" in body):
            raise StoreError(str(body.get("error") if isinstance(body, dict) else response.status_code))
        return body.get("result")


class MemoryStore:
    def __init__(self):
        self.data: dict[str, Any] = {}
        self.expiry: dict[str, int] = {}

    def run(self, *command) -> Any:
        name, *args = [str(c) for c in command]
        name = name.upper()
        if name == "GET":
            return self.data.get(args[0])
        if name == "SET":
            self.data[args[0]] = args[1]
            return "OK"
        if name == "DEL":
            return sum(1 for key in args if self.data.pop(key, None) is not None)
        if name in ("INCR", "DECR"):
            value = int(self.data.get(args[0], 0)) + (1 if name == "INCR" else -1)
            self.data[args[0]] = str(value)
            return value
        if name == "EXPIRE":
            self.expiry[args[0]] = int(args[1])
            return 1 if args[0] in self.data else 0
        if name == "HSET":
            table = self.data.setdefault(args[0], {})
            added = 0
            for field, value in zip(args[1::2], args[2::2]):
                added += field not in table
                table[field] = value
            return added
        if name == "HGETALL":
            return [item for pair in self.data.get(args[0], {}).items() for item in pair]
        if name == "SCAN":
            pattern = args[args.index("MATCH") + 1] if "MATCH" in args else "*"
            return ["0", [k for k in self.data if fnmatch.fnmatchcase(k, pattern)]]
        raise StoreError(f"unsupported command {name}")


def hgetall(store, key) -> dict[str, str]:
    flat = store.run("HGETALL", key) or []
    return dict(zip(flat[0::2], flat[1::2]))
