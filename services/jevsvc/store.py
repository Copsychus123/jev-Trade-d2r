"""Redis access: Upstash REST in production, an in-memory stand-in for tests and local dev.

Both stores offer `run(*command)` for one command and `pipeline(commands, atomic=False)` for several in one round trip
(`atomic=True` is a transaction: all or none, no other client in between)."""

import fnmatch
import threading
import time
from typing import Any

import httpx


class StoreError(RuntimeError):
    pass


def _unsupported(name: str) -> StoreError:
    """The router's tuple and the family method that serves it must agree; a drift is loud, never a silent None."""
    return StoreError(f"unsupported command {name}")


def _raise_if_error(reply: dict) -> None:
    """Upstash answers a failed command with {"error": ...} in place of {"result": ...}."""
    if "error" in reply:
        raise StoreError(str(reply["error"]))


class Store:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self.client = httpx.Client(timeout=10)

    def _post(self, url: str, payload) -> Any:
        try:
            response = self.client.post(url, json=payload, headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as exc:
            raise StoreError(f"store unreachable: {type(exc).__name__}") from exc
        try:
            body = response.json()
        except ValueError:
            body = None
        if not response.is_success:
            detail = body.get("error") if isinstance(body, dict) else None
            raise StoreError(str(detail or response.status_code))
        return body

    def run(self, *command) -> Any:
        body = self._post(self.url, [str(c) for c in command])
        if not isinstance(body, dict):
            raise StoreError("unexpected store reply")
        _raise_if_error(body)
        return body.get("result")

    def pipeline(self, commands, atomic: bool = False) -> list:
        commands = [[str(c) for c in command] for command in commands]
        body = self._post(f"{self.url}/{'multi-exec' if atomic else 'pipeline'}", commands)
        if isinstance(body, dict):  # a rejected transaction is one error, not a list
            _raise_if_error(body)
        if not isinstance(body, list) or len(body) != len(commands) or not all(isinstance(r, dict) for r in body):
            raise StoreError("unexpected store reply")
        for reply in body:
            _raise_if_error(reply)
        return [reply.get("result") for reply in body]


_shared: tuple[tuple[str, str], Store] | None = None
_shared_lock = threading.Lock()


def shared_store(url: str, token: str) -> Store:
    """One Store (and so one pooled HTTP client) per process while the settings stay the same; a warm Vercel
    instance serves many requests and must not open a new connection pool for each."""
    global _shared
    with _shared_lock:
        if _shared is None or _shared[0] != (url, token):
            if _shared is not None:
                _shared[1].client.close()
            _shared = ((url, token), Store(url, token))
        return _shared[1]


class MemoryStore:
    """The commands the service uses, with Redis semantics for expiry. `clock` returns seconds (injectable so a test
    can move time); every operation holds one lock, so a pipeline is atomic and threads cannot interleave."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.data: dict[str, Any] = {}
        self.expiry: dict[str, float] = {}  # key -> clock() value at which the key is gone
        self._lock = threading.RLock()

    def run(self, *command) -> Any:
        with self._lock:
            return self._execute(command)

    def pipeline(self, commands, atomic: bool = False) -> list:
        with self._lock:
            return [self._execute(command) for command in commands]

    def _purge(self) -> None:
        now = self.clock()
        for key in [key for key, deadline in self.expiry.items() if deadline <= now]:
            self.data.pop(key, None)
            del self.expiry[key]

    def _drop_if_empty(self, key) -> None:
        if key in self.data and not self.data[key]:  # Redis deletes a hash that lost its last field
            del self.data[key]
            self.expiry.pop(key, None)

    def _execute(self, command) -> Any:
        self._purge()
        name, *args = [str(c) for c in command]
        name = name.upper()
        if name in ("GET", "SET", "INCR", "DECR", "INCRBY", "DECRBY"):
            return self._string(name, args)
        if name in ("HSET", "HSETNX", "HGET", "HEXISTS", "HINCRBY", "HDEL", "HGETALL"):
            return self._hash(name, args)
        if name in ("DEL", "EXPIRE", "SCAN"):
            return self._keyspace(name, args)
        raise _unsupported(name)

    def _string(self, name, args) -> Any:
        """GET, SET and the INCR/DECR family: one value per key (counters kept as strings, as Redis does)."""
        data = self.data
        if name == "GET":
            return data.get(args[0])
        if name == "SET":
            rest = args[2:]
            options = [a.upper() for a in rest]
            if "NX" in options and args[0] in data:
                return None
            data[args[0]] = args[1]
            self.expiry.pop(args[0], None)  # SET replaces the value and its lifetime
            if "EX" in options:
                self.expiry[args[0]] = self.clock() + int(rest[options.index("EX") + 1])
            return "OK"
        if name in ("INCR", "DECR", "INCRBY", "DECRBY"):
            step = int(args[1]) if name.endswith("BY") else 1
            value = int(data.get(args[0], 0)) + (step if name.startswith("INCR") else -step)
            data[args[0]] = str(value)
            return value
        raise _unsupported(name)

    def _hash(self, name, args) -> Any:
        data = self.data
        if name == "HSET":
            table = data.setdefault(args[0], {})
            added = 0
            for field, value in zip(args[1::2], args[2::2]):
                added += field not in table
                table[field] = value
            return added
        if name == "HSETNX":
            table = data.setdefault(args[0], {})
            if args[1] in table:
                return 0
            table[args[1]] = args[2]
            return 1
        if name == "HGET":
            return data.get(args[0], {}).get(args[1])
        if name == "HEXISTS":
            return int(args[1] in data.get(args[0], {}))
        if name == "HINCRBY":
            table = data.setdefault(args[0], {})
            table[args[1]] = str(int(table.get(args[1], 0)) + int(args[2]))
            return int(table[args[1]])
        if name == "HDEL":
            table = data.get(args[0], {})
            removed = sum(1 for field in args[1:] if table.pop(field, None) is not None)
            self._drop_if_empty(args[0])
            return removed
        if name == "HGETALL":
            return [item for pair in data.get(args[0], {}).items() for item in pair]
        raise _unsupported(name)

    def _keyspace(self, name, args) -> Any:
        data = self.data
        if name == "DEL":
            for key in args:
                self.expiry.pop(key, None)
            return sum(1 for key in args if data.pop(key, None) is not None)
        if name == "EXPIRE":
            key, seconds, *conditions = args
            if key not in data:
                return 0
            current = self.expiry.get(key)
            condition = conditions[0].upper() if conditions else ""
            if (condition == "NX" and current is not None) or (condition == "XX" and current is None):
                return 0
            deadline = self.clock() + int(seconds)
            if (condition == "GT" and (current is None or deadline <= current)) or (
                condition == "LT" and current is not None and deadline >= current
            ):
                return 0
            self.expiry[key] = deadline
            return 1
        if name == "SCAN":
            pattern = args[args.index("MATCH") + 1] if "MATCH" in args else "*"
            return ["0", [k for k in data if fnmatch.fnmatchcase(k, pattern)]]
        raise _unsupported(name)


def hgetall(store, key) -> dict[str, str]:
    return fields_to_dict(store.run("HGETALL", key))


def fields_to_dict(flat) -> dict[str, str]:
    """A flat [field, value, ...] reply (as HGETALL returns) as a dict."""
    flat = flat or []
    return dict(zip(flat[0::2], flat[1::2]))
