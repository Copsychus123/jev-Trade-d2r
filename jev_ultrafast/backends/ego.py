"""Task-scoped persistent Ego Browser backend."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

from ..browser import StalePage
from .transport import (
    EgoMalformedResponse,
    EgoProcessExited,
    EgoRemoteError,
    EgoTimeout,
    EgoTransport,
    EgoTransportError,
)

READ_STATE = Path(__file__).resolve().parents[1].joinpath("snapshot.js").read_text()
_ACTION_SETTLE_DELAYS_MS = (100, 200, 300, 300)
_FILL_OBSERVE_SETTLE_INITIAL_MS = 500
_FILL_OBSERVE_SETTLE_INTERVAL_MS = 200
_FILL_OBSERVE_SETTLE_BUDGET_MS = 900

_DISPATCHER = r"""
globalThis.__jevUltrafastRuntime ||= {};
globalThis.__jevUltrafastDispatch = async request => {
  const payload = request?.payload || {};
  const runtime = globalThis.__jevUltrafastRuntime;
  if (request?.op === "init") {
    if (!runtime.task) {
      runtime.task = await taskSpace(String(payload.task_name));
      runtime.page = runtime.task.page(String(payload.page_label || "p1"));
      await runtime.page.goto(String(payload.url), {
        waitUntil: "domcontentloaded",
        timeout: Number(payload.timeout_ms || 15000),
      });
    }
    return {
      space_id: runtime.task.spaceId,
      page_label: runtime.page.label,
      page_target_id: runtime.page.targetId,
    };
  }
  if (!runtime.page) throw new Error("Ego task space is not initialized");
  if (request?.op === "observe") {
    const state = await runtime.page.evaluate(globalThis.__jevReadState);
    if (!state) throw new Error("Ego page is navigating");
    const semantic = await runtime.page.snapshot({scope: "only_within_viewport"});
    let screenshot = null;
    if (payload.screenshot) {
      const fs = await import("node:fs/promises");
      const path = `/tmp/jev-ultrafast-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
      try {
        await runtime.page.screenshot({path, scale: "css"});
        screenshot = (await fs.readFile(path)).toString("base64");
      } finally {
        await fs.unlink(path).catch(() => {});
      }
    }
    return {
      state,
      semantic,
      screenshot,
      url: await runtime.page.url(),
      title: await runtime.page.title(),
    };
  }
  if (request?.op === "fresh") {
    const state = await runtime.page.evaluate(globalThis.__jevReadState);
    if (!state) throw new Error("Ego page is navigating");
    return {state};
  }
  if (request?.op === "act") {
    const action = payload.action || {};
    const ref = action.ref;
    const label = String(action.label || action.kind || "browser action");
    if (action.kind === "click") {
      if (!ref) throw new Error("unknown ref");
      await runtime.page.click(ref, {label});
    } else if (action.kind === "fill") {
      if (!ref) throw new Error("unknown ref");
      await runtime.page.fill(ref, String(payload.text ?? ""), {clearFirst: true});
    } else if (action.kind === "select") {
      if (!ref) throw new Error("unknown ref");
      await runtime.page.selectOption(ref, String(action.value ?? ""));
    } else if (action.kind === "scroll") {
      await runtime.page.mouse.wheel(0, Number(action.delta || 0), {label});
    } else if (action.kind === "wait") {
      await runtime.page.waitForTimeout(Number(payload.wait_ms || 100));
    } else {
      throw new Error(`unsupported action kind: ${String(action.kind)}`);
    }
    return {executed: action.id || action.kind};
  }
  if (request?.op === "finish") {
    if (runtime.task) return await runtime.task.finish({keep: []});
    return null;
  }
  throw new Error(`unsupported Ego operation: ${String(request?.op)}`);
};
"""


_CONTROL_ROLES = {
    "anchor": "link",
    "button": "button",
    "checkbox": "checkbox",
    "combobox": "combobox",
    "gridcell": "gridcell",
    "link": "link",
    "menuitem": "menuitem",
    "menuitemradio": "menuitemradio",
    "option": "option",
    "radio": "radio",
    "searchbox": "searchbox",
    "spinbutton": "spinbutton",
    "switch": "switch",
    "tab": "tab",
    "textbox": "textbox",
}
_ROLE_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_-]*)\b")
_REF_RE = re.compile(r"(?:\[|,|\s)(?:ref=|@)(@?[A-Za-z0-9_-]+)")
_QUOTE_RE = re.compile(r'\s"((?:\\.|[^"\\])*)"')


def _unquote(value: str) -> str:
    try:
        return str(json.loads('"' + value + '"'))
    except (TypeError, ValueError):
        return value.replace('\\"', '"')


def _snapshot_nodes(snapshot: str | None) -> list[dict[str, str]]:
    """Extract only code-owned refs and names from Ego's semantic snapshot."""
    if not isinstance(snapshot, str):
        return []
    lines = snapshot.splitlines()
    nodes: list[dict[str, str]] = []
    for index, line in enumerate(lines):
        match = _ROLE_RE.match(line)
        if not match:
            continue
        raw_role = match.group(1).lower()
        role = _CONTROL_ROLES.get(raw_role)
        if role is None:
            continue
        ref_match = _REF_RE.search(line)
        if not ref_match:
            continue
        label_match = _QUOTE_RE.search(line)
        label = _unquote(label_match.group(1)) if label_match else ""
        indent = len(line) - len(line.lstrip())
        child_text: list[str] = []
        if not label:
            for child in lines[index + 1 :]:
                child_indent = len(child) - len(child.lstrip())
                if child.strip() and child_indent <= indent:
                    break
                text_match = re.match(r'^\s*text\s+"((?:\\.|[^"\\])*)"', child)
                if text_match:
                    child_text.append(_unquote(text_match.group(1)))
        if child_text:
            label = " ".join(child_text).strip()
        attrs = ref_match.group(0)
        value_match = re.search(r'value="((?:\\.|[^"\\])*)"', line)
        nodes.append(
            {
                "role": role,
                "ref": "@" + ref_match.group(1).lstrip("@"),
                "label": label,
                "value": _unquote(value_match.group(1)) if value_match else "",
                "attrs": attrs,
            }
        )
    return nodes


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def _state_fingerprint(state: dict[str, Any]) -> str:
    # ``ref`` is an adapter detail.  Ego's semantic ref is re-created by each
    # snapshot, while Jev freshness is defined by the observed page meaning.
    actions = [
        {key: value for key, value in action.items() if key not in {"ref", "rect"}}
        for action in state.get("actions", [])
        if isinstance(action, dict)
    ]
    content = {
        "url": state.get("url"),
        "text": state.get("text"),
        "actions": actions,
        "scroll": state.get("scroll"),
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _action_signature(page: dict[str, Any]) -> str:
    actions = [
        {key: value for key, value in action.items() if key not in {"id", "ref", "rect"}}
        for action in page.get("actions", [])
        if isinstance(action, dict)
    ]
    guards = {}
    for node, guard in page.get("guards", {}).items():
        # Keep code-owned identity and target state, while ignoring nearby
        # scope text that can change as autocomplete renders.
        guards[str(node)] = guard[:-1] if isinstance(guard, list) else guard
    content = {"url": page.get("url"), "actions": actions, "guards": guards}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class EgoBrowserBackend:
    """One Ego TaskSpace/Page reused by every observe and action in a task."""

    backend_name = "ego"

    def __init__(
        self,
        url: str,
        *,
        transport: EgoTransport | Any | None = None,
        task_name: str | None = None,
        timeout_ms: int = 15_000,
        page_label: str = "p1",
    ) -> None:
        self.url = url
        self.timeout_ms = timeout_ms
        self.page_label = page_label
        self.task_name = task_name or f"ultrafast:{uuid.uuid4().hex}"
        self.transport = transport or EgoTransport(timeout_ms=timeout_ms)
        self._generation = 0
        self._current_page: dict[str, Any] | None = None
        self._pending_fill_settle = False
        self._closed = False
        self._init_result: dict[str, Any] = {}
        self.timings: dict[str, int] = {"startup_ms": 0, "cleanup_ms": 0}
        self.ego_timings: dict[str, Any] = {
            "observe": {"count": 0, "total_ms": 0, "max_ms": 0, "last_ms": 0},
            "fresh": {"count": 0, "total_ms": 0, "max_ms": 0, "last_ms": 0},
            "act": {"count": 0, "total_ms": 0, "max_ms": 0, "last_ms": 0},
            "ego_total_operation_ms": 0,
        }
        self.cleanup_status: dict[str, bool | None] = {
            "graceful_exit": None,
            "forced_terminate": None,
            "forced_kill": None,
            "orphan_process_remaining": None,
        }
        self.runtime_spawn_count = 0
        started = time.perf_counter()
        try:
            if hasattr(self.transport, "start"):
                try:
                    self.transport.start(self._dispatcher_source())
                except TypeError:
                    self.transport.start()
            self.runtime_spawn_count = int(getattr(self.transport, "runtime_spawn_count", 1))
            self._init_result = self._request_raw(
                "init",
                {"url": url, "task_name": self.task_name, "page_label": page_label, "timeout_ms": timeout_ms},
            ) or {}
        except BaseException:
            self.close()
            raise
        finally:
            self.timings["startup_ms"] = round((time.perf_counter() - started) * 1000)

    @staticmethod
    def _dispatcher_source() -> str:
        # The interactive REPL treats a physical newline as the end of a
        # submission.  Keep the bootstrap one line even though the source
        # above is formatted for maintenance.
        dispatcher = re.sub(r"\s+", " ", _DISPATCHER).strip()
        return f"globalThis.__jevReadState={json.dumps(READ_STATE)};{dispatcher}"

    def _request_raw(self, operation: str, payload: dict[str, Any] | None = None) -> Any:
        return self.transport.request(operation, payload or {}, timeout_ms=self.timeout_ms)

    def _request_timed(self, operation: str, payload: dict[str, Any] | None = None) -> Any:
        started = time.perf_counter()
        try:
            result = self._request_raw(operation, payload)
            return result
        finally:
            elapsed = round((time.perf_counter() - started) * 1000)
            item = self.ego_timings.setdefault(operation, {"count": 0, "total_ms": 0, "max_ms": 0, "last_ms": 0})
            if isinstance(item, dict):
                item["count"] += 1
                item["total_ms"] += elapsed
                item["max_ms"] = max(item["max_ms"], elapsed)
                item["last_ms"] = elapsed
            self.ego_timings["ego_total_operation_ms"] += elapsed

    def _normalize_page(self, response: dict[str, Any]) -> dict[str, Any]:
        state = response.get("state", response)
        if not isinstance(state, dict):
            raise EgoMalformedResponse("Ego observation did not contain a state object")
        page = dict(state)
        semantic = response.get("semantic") if isinstance(response, dict) else None
        actions = [dict(action) for action in page.get("actions", []) if isinstance(action, dict)]
        refs = _snapshot_nodes(semantic)
        by_node: dict[str, str] = {}
        used: set[str] = set()
        for action in actions:
            if action.get("ref"):
                continue
            node_key = str(action.get("node", ""))
            if node_key in by_node:
                action["ref"] = by_node[node_key]
                continue
            role = str(action.get("role", "")).casefold()
            label = _norm(action.get("label", ""))
            base_label = _norm(str(action.get("label", "")).split(" → ", 1)[0])
            value = _norm(action.get("value", ""))
            candidates = [item for item in refs if item["role"] == role or (role == "link" and item["role"] == "link")]
            ranked = sorted(
                candidates,
                key=lambda item: (
                    item["ref"] in used,
                    _norm(item["label"]) != label,
                    bool(base_label) and base_label not in _norm(item["label"]),
                    bool(value) and value != _norm(item["value"]),
                ),
            )
            if ranked:
                selected = ranked[0]
                action["ref"] = selected["ref"]
                by_node[node_key] = selected["ref"]
                used.add(selected["ref"])
        page["actions"] = actions
        page.setdefault("url", response.get("url", self.url))
        page.setdefault("title", response.get("title", ""))
        page.setdefault("text", "")
        page.setdefault("scroll", {"y": 0, "height": 0})
        page.setdefault("guards", {})
        page["guards"] = {str(key): value for key, value in page["guards"].items()}
        page["fingerprint"] = page.get("fingerprint") or _state_fingerprint(page)
        page["generation"] = self._generation
        page["ego_space_id"] = self._init_result.get("space_id")
        page["ego_page_label"] = self.page_label
        screenshot = response.get("screenshot") if isinstance(response, dict) else None
        if isinstance(screenshot, str) and screenshot:
            page["screenshot"] = screenshot
        return page

    def _observe_page(self, screenshot: bool = False) -> dict[str, Any]:
        response = None
        for attempt in range(10):
            try:
                response = self._request_timed("observe", {"screenshot": bool(screenshot)})
                break
            except EgoRemoteError as error:
                if not _looks_navigation(str(error)) or attempt == 9:
                    if _looks_navigation(str(error)):
                        raise StalePage(str(error)) from error
                    raise
                # Read-only settle retry. Browser mutations never use this
                # loop, so a late action cannot be replayed accidentally.
                time.sleep(0.02)
        if not isinstance(response, dict):
            raise EgoMalformedResponse("Ego observe response is not an object")
        return self._normalize_page(response)

    def _settled_fill_observe(self, screenshot: bool) -> dict[str, Any]:
        # Autocomplete can replace the input form after fill.  Wait for the
        # action semantics to stop changing, then expose only the final refs.
        deadline = time.monotonic() + _FILL_OBSERVE_SETTLE_BUDGET_MS / 1000
        time.sleep(_FILL_OBSERVE_SETTLE_INITIAL_MS / 1000)
        page = self._observe_page(screenshot=screenshot)
        previous = _action_signature(page)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(_FILL_OBSERVE_SETTLE_INTERVAL_MS / 1000, remaining))
            candidate = self._observe_page(screenshot=screenshot)
            signature = _action_signature(candidate)
            page = candidate
            if signature == previous:
                break
            previous = signature
        return page

    def observe(self, screenshot: bool = False) -> dict[str, Any]:
        if self._closed:
            raise EgoTransportError("Ego backend is closed")
        if self._pending_fill_settle:
            page = self._settled_fill_observe(screenshot)
            self._pending_fill_settle = False
        else:
            page = self._observe_page(screenshot)
        self._generation += 1
        page["generation"] = self._generation
        self._current_page = page
        return page

    @staticmethod
    def _same_page(old: dict[str, Any], current: dict[str, Any]) -> bool:
        if old.get("fingerprint") and current.get("fingerprint"):
            return old["fingerprint"] == current["fingerprint"]
        return _state_fingerprint(old) == _state_fingerprint(current)

    def fresh(self, page: dict[str, Any], action: dict[str, Any] | None = None) -> bool:
        if self._closed or not isinstance(page, dict) or page.get("generation") != self._generation:
            return False
        try:
            response = self._request_timed("fresh", {})
            current = self._normalize_page(response if isinstance(response, dict) else {})
        except EgoRemoteError as error:
            if _looks_stale(str(error)):
                raise StalePage(str(error)) from error
            raise
        if action and action.get("kind") in {"click", "fill", "select"}:
            node = action.get("node")
            if action.get("kind") in {"click", "select"}:
                # The target guard contains the code-owned node identity,
                # role/name/value state, and nearby semantic context.  Keep
                # URL as the document boundary, while allowing unrelated
                # page text and late-added form controls to settle.
                if page.get("url") != current.get("url"):
                    return False
            elif not self._same_page(page, current):
                return False
            if node is not None:
                expected = page.get("guards", {}).get(str(node))
                actual = current.get("guards", {}).get(str(node))
                if expected != actual:
                    if action.get("kind") in {"click", "select"} and expected is not None:
                        # A fill can briefly hide an autocomplete target while
                        # its popup settles.  Re-read only; never replay the
                        # pending mutation.  A replacement or changed target
                        # remains stale when the bounded settle expires.
                        for wait_ms in _ACTION_SETTLE_DELAYS_MS:
                            time.sleep(wait_ms / 1000)
                            try:
                                response = self._request_timed("fresh", {})
                            except EgoRemoteError as error:
                                if _looks_stale(str(error)):
                                    raise StalePage(str(error)) from error
                                raise
                            current = self._normalize_page(
                                response if isinstance(response, dict) else {}
                            )
                            if page.get("url") != current.get("url"):
                                return False
                            actual = current.get("guards", {}).get(str(node))
                            if expected == actual:
                                return True
                    return False
            return True
        if not self._same_page(page, current):
            return False
        return True

    def act(self, action: dict[str, Any], page: dict[str, Any], text: str | None = None) -> Any:
        if action.get("kind") in {"done", "blocked"}:
            return {"executed": action.get("id", action.get("kind"))}
        if self._closed:
            raise EgoTransportError("Ego backend is closed")
        if page.get("generation") != self._generation or not self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        if action.get("kind") in {"click", "fill", "select"} and not action.get("ref"):
            raise StalePage("Observed Ego target has no valid ref")
        try:
            result = self._request_timed(
                "act",
                {"action": {key: value for key, value in action.items() if key != "rect"}, "text": text},
            )
            if action.get("kind") == "fill":
                self._pending_fill_settle = True
            return result
        except (EgoRemoteError, EgoProcessExited, EgoTimeout) as error:
            if _looks_stale(str(error)) or isinstance(error, EgoProcessExited):
                raise StalePage(str(error)) from error
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        started = time.perf_counter()
        try:
            if hasattr(self.transport, "request"):
                try:
                    self.transport.request("finish", {}, timeout_ms=min(self.timeout_ms, 2_000))
                except BaseException:
                    pass
            if hasattr(self.transport, "close"):
                self.transport.close()
        finally:
            self.timings["cleanup_ms"] = round((time.perf_counter() - started) * 1000)
            status = getattr(self.transport, "cleanup_status", None)
            if isinstance(status, dict):
                self.cleanup_status.update(status)
            self.runtime_spawn_count = int(
                getattr(self.transport, "runtime_spawn_count", self.runtime_spawn_count)
            )

    @property
    def orphan_process_remaining(self) -> bool | None:
        return self.cleanup_status.get("orphan_process_remaining")

    @property
    def graceful_exit(self) -> bool | None:
        return self.cleanup_status.get("graceful_exit")

    @property
    def forced_terminate(self) -> bool | None:
        return self.cleanup_status.get("forced_terminate")

    @property
    def forced_kill(self) -> bool | None:
        return self.cleanup_status.get("forced_kill")

    def __enter__(self) -> "EgoBrowserBackend":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _looks_stale(message: str) -> bool:
    value = message.casefold()
    return any(
        marker in value
        for marker in (
            "unknown ref",
            "invalid ref",
            "no element",
            "no actionable",
            "no matching",
            "selector",
            "stale",
            "detached",
            "not found",
            "does not exist",
            "target changed",
            "page changed",
            "page is navigating",
            "execution context",
            "no longer attached",
        )
    )


def _looks_navigation(message: str) -> bool:
    value = message.casefold()
    return any(marker in value for marker in ("page is navigating", "document is navigating", "execution context"))


__all__ = [
    "EgoBrowserBackend",
    "EgoMalformedResponse",
    "EgoProcessExited",
    "EgoRemoteError",
    "EgoTimeout",
    "EgoTransport",
    "EgoTransportError",
]
