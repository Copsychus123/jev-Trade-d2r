"""Probe of how Traderie D2R lists an item (上架), in the dedicated Chrome. Nothing is posted by this script.

Two modes (both need the one-time Traderie login: `uv run python scripts/login.py`; Windows; no Jev, no quota):

  --observe        (default) opens the product pages of `harlequin-crest` and `ring`, records every `/api/`
                   response the page itself makes, finds the one that carries the item's own record (an `id` and a
                   `properties` list with `property_id`/`name`/`required`) and prints `ITEM_PATH=<path with {slug}>`
                   (or `ITEM_PATH=NOT_FOUND`). Also reads the player's own listings (`listings?seller=<id>`),
                   `users/details` (skip_captcha) and the game's feature list (LISTINGS:CAPTCHA).
                   Read-only: GET requests only.
  --record-create  (visible Chrome: run with `env JEV_CHROME=window`) opens `--slug`'s product page and only
                   *watches* while the owner adds one real listing by hand with Traderie's own Add Listing form; it
                   records the create request (URL, method, headers with the login token redacted, body) and its
                   answer, any captcha request, and whether the listing shows up in the player's own listings.

Findings go to artifacts/probe/ and the two test fixtures; the decisions they settle are written into
docs/design.md ("Listing on Traderie").
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cdp import open_dedicated_tab  # noqa: E402
from _probe import GAMES_PATH, Tab, game_features, write_json  # noqa: E402

from jev_ultrafast.chrome import close_chrome  # noqa: E402
from jev_ultrafast.traderie.site import TRADERIE_D2R_URL  # noqa: E402

OUT = ROOT / "artifacts" / "probe"
FIXTURES = ROOT / "extension" / "test" / "fixtures"
ITEM_QUERY = "&variants=&tags=&properties=&adding=true"
USER_PATH = "/api/diablo2resurrected/user?"
DETAILS_PATH = "/api/diablo2resurrected/users/details?"
OBSERVE_SLUGS = ("harlequin-crest", "ring")
CAPTCHA_WORDS = ("captcha", "turnstile", "hcaptcha", "recaptcha")
BODY_HEAD = 2000


async def drain(tab: Tab) -> None:
    """Let the websocket deliver pending events (they are only read while a command is waited for)."""
    await tab.send("Runtime.evaluate", {"expression": "1"})


async def response_body_head(tab: Tab, request_id: str) -> str:
    """The first BODY_HEAD characters of a response's body, or a note that the browser no longer has it."""
    try:
        reply = await tab.send("Network.getResponseBody", {"requestId": request_id})
        return (reply.get("body") or "")[:BODY_HEAD]
    except RuntimeError as error:
        return f"<no body: {error}>"


def is_item_record(body) -> dict | None:
    """The item record inside a body: `{items: [record]}`, a one-element list or the record itself; a record has `id`
    and a `properties` list whose entries carry property_id / name / required."""
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        body = body["items"]
    if isinstance(body, list) and len(body) == 1:
        body = body[0]
    if not isinstance(body, dict):
        return None
    properties = body.get("properties")
    if "id" not in body or not isinstance(properties, list) or not properties:
        return None
    first = properties[0]
    if isinstance(first, dict) and {"property_id", "name", "required"} <= set(first):
        return body
    return None


def api_responses(events: list[dict]) -> list[dict]:
    found = []
    for event in events:
        if event.get("method") != "Network.responseReceived":
            continue
        params = event["params"]
        url = params["response"]["url"]
        if "/api/" in url:
            found.append({"requestId": params["requestId"], "url": url, "status": params["response"]["status"]})
    return found


async def own_listings(tab: Tab, name: str = "listing-user.json") -> dict:
    """The signed-in player's own open listings (the page the site's profile uses: `listings?seller=<id>`)."""
    me = (await tab.fetch_json(USER_PATH))["body"]["user"]["id"]
    path = (
        "/api/diablo2resurrected/listings?itemTags=true&selling=true&auction=false&page=0"
        f"&seller={me}&completed=false&active=all"
    )
    reply = await tab.fetch_json(path)
    write_json(OUT / name, reply)
    return reply


async def find_item_record(tab: Tab, slug: str, responses: list[dict]) -> tuple[str | None, dict | None]:
    """The first observed API address that answers with the product's item record, and that record."""
    for response in responses:
        url = response["url"]
        if slug in url or re.search(r"/\d+(\?|$)", url):
            path = re.sub(r"^https?://[^/]+", "", url)
            reply = await tab.fetch_json(path)
            item = is_item_record(reply.get("body"))
            if item:
                return path, item
    return None, None


async def observe_slug(tab: Tab, slug: str) -> dict:
    tab.events.clear()
    await tab.goto(f"{TRADERIE_D2R_URL}/product/{slug}")
    await tab.settled_text()
    await drain(tab)
    responses = api_responses(tab.events)
    for response in responses:
        response["bodyHead"] = await response_body_head(tab, response["requestId"])
    write_json(OUT / f"listing-observe-{slug}.json", responses)

    item_path, item = await find_item_record(tab, slug, responses)
    result = {"slug": slug, "api_urls": [r["url"] for r in responses], "item_path": item_path}
    if item:
        result["item_id"] = item["id"]
        result["item_type"] = item.get("type")
        result["property_names"] = [p.get("name") for p in item["properties"]]
        write_json(OUT / f"listing-item-{slug}.json", item)
    else:
        extra = await tab.evaluate(
            "JSON.stringify({next: document.querySelector('#__NEXT_DATA__')?.textContent?.slice(0, 20000) ?? null, "
            "inline: [...document.querySelectorAll('script:not([src])')].map(s => s.textContent)"
            f".filter(t => t.includes({json.dumps(slug)})).map(t => t.slice(0, 5000)).slice(0, 5)}})"
        )
        write_json(OUT / f"listing-observe-{slug}-inline.json", json.loads(extra))
    return result


async def observe() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    async with open_dedicated_tab(Tab, collect_events=True) as tab:
        await tab.send("Network.enable")
        found = {}
        for slug in OBSERVE_SLUGS:
            found[slug] = await observe_slug(tab, slug)
        user = await own_listings(tab)
        paths = {r["item_path"] for r in found.values() if r["item_path"]}
        for slug, result in found.items():
            print(f"{slug}: {json.dumps(result, ensure_ascii=False)}")
        if paths:
            print("ITEM_PATH=/api/diablo2resurrected/items?id={slug}" + ITEM_QUERY)
        else:
            print("ITEM_PATH=NOT_FOUND")
        print(f"own listings: status {user.get('status')} body head {json.dumps(user.get('body'))[:200]}")
        details = (await tab.fetch_json(DETAILS_PATH))["body"].get("details", {})
        games = (await tab.fetch_json(GAMES_PATH))["body"]
        needs_captcha = "LISTINGS:CAPTCHA" in game_features(games)
        print("skip_captcha:", details.get("skip_captcha"), "| LISTINGS:CAPTCHA feature:", needs_captcha)
        return 0 if paths else 1


def redact_headers(headers: dict) -> dict:
    return {k: ("Bearer …" if k.lower() == "authorization" else v) for k, v in headers.items() if k.lower() != "cookie"}


async def note_event(tab: Tab, watched: dict[str, dict], event: dict) -> None:
    """Keep what a create attempt sends and receives: every request to a listings address that is not a plain read,
    and every request to a captcha host, with its status, post data and the start of its answer."""
    params = event.get("params", {})
    method = event.get("method")
    if method == "Network.requestWillBeSent":
        request = params["request"]
        url = request["url"]
        is_listings = "/listings" in url
        if not (is_listings or any(word in url.lower() for word in CAPTCHA_WORDS)):
            return
        if request["method"] == "GET" and is_listings and "create" not in url:
            return
        watched[params["requestId"]] = {
            "url": url,
            "method": request["method"],
            "headers": redact_headers(request.get("headers", {})),
            "postData": request.get("postData"),
            "hasPostData": request.get("hasPostData"),
        }
    elif method == "Network.responseReceived" and params["requestId"] in watched:
        watched[params["requestId"]]["status"] = params["response"]["status"]
    elif method == "Network.loadingFinished" and params["requestId"] in watched:
        entry = watched[params["requestId"]]
        if entry.get("postData") is None and entry.get("hasPostData"):
            try:
                reply = await tab.send("Network.getRequestPostData", {"requestId": params["requestId"]})
                entry["postData"] = reply.get("postData")
            except RuntimeError as error:
                entry["postData"] = f"<unavailable: {error}>"
        entry["bodyHead"] = await response_body_head(tab, params["requestId"])


async def record_create(slug: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    async with open_dedicated_tab(Tab, collect_events=True) as tab:
        await tab.send("Network.enable")
        await tab.goto(f"{TRADERIE_D2R_URL}/product/{slug}")
        await tab.settled_text()
        print("請在這個視窗按 Add Listing，填一個真實掛單（可勾 Make an Offer）並送出；完成後回到這裡按 Enter")
        done = asyncio.get_running_loop().run_in_executor(None, input)
        watched: dict[str, dict] = {}
        seen = 0
        while not done.done():
            await asyncio.sleep(0.5)
            await drain(tab)
            for event in tab.events[seen:]:
                await note_event(tab, watched, event)
            seen = len(tab.events)
        await done
        user = await own_listings(tab, "listing-user-after.json")
        recorded = list(watched.values())
        write_json(OUT / "listing-create.json", recorded)
        return report_create(recorded, user)


def multipart_names(post_data: str) -> list[str]:
    return re.findall(r'name="([^"]+)"', post_data or "")


def multipart_json(post_data: str) -> dict | None:
    """The JSON of the `body` field of a multipart post (or the whole post when it is plain JSON)."""
    text = post_data or ""
    match = re.search(r'name="body"\r?\n\r?\n(.*?)\r?\n--', text, re.S)
    candidate = match.group(1) if match else text
    try:
        value = json.loads(candidate)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def report_create(recorded: list[dict], user: dict) -> int:
    creates = [r for r in recorded if "create" in r["url"] and r["method"] == "POST"]
    captchas = [r["url"] for r in recorded if any(w in r["url"].lower() for w in CAPTCHA_WORDS)]
    if not creates:
        print("沒有記到 listings/create 的請求；所有記到的請求：")
        for r in recorded:
            print(" ", r["method"], r["url"], r.get("status"))
        return 1
    create = creates[0]
    body = multipart_json(create.get("postData"))
    print("create URL:", create["method"], create["url"])
    print("content-type:", create["headers"].get("Content-Type") or create["headers"].get("content-type"))
    print("multipart fields:", multipart_names(create.get("postData")))
    print("body keys:", sorted(body) if body else None)
    print("captcha empty:", bool(body) and not body.get("captcha"))
    print("captcha requests:", captchas)
    print("response status:", create.get("status"))
    answer = None
    try:
        answer = json.loads(create.get("bodyHead") or "")
    except ValueError:
        pass
    print("response top-level keys:", sorted(answer) if isinstance(answer, dict) else create.get("bodyHead", "")[:200])
    if body:
        write_json(FIXTURES / "listing_create.json", body)
        listed = json.dumps(user.get("body"))
        print("item in own listings:", f'"{body.get("item")}"' in listed or f": {body.get('item')}" in listed)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--observe", action="store_true", help="default mode")
    parser.add_argument("--record-create", action="store_true")
    parser.add_argument("--slug", default="ber-rune", help="product for --record-create")
    args = parser.parse_args()
    try:
        if args.record_create:
            return asyncio.run(record_create(args.slug))
        return asyncio.run(observe())
    finally:
        close_chrome()


if __name__ == "__main__":
    sys.exit(main())
