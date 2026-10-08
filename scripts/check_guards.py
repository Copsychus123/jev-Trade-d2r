"""Local-browser freshness/execution regressions. No model calls or external websites.

Every check is recorded; the script raises one AssertionError listing all failed checks at the end (it does not rely
on `assert`, which `python -O` removes). Needs the dedicated Chrome that `Browser` starts itself (Windows/macOS/Linux
with Chrome installed; the profile folder is shared with the demo).
"""

from urllib.parse import quote

from jev_ultrafast.browser import Browser
from jev_ultrafast.errors import StalePage

HTML = """<!doctype html><title>Guard checks</title>
<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
<label>City<input id="field" value="Zurich"></label>
<label><input id="toggle" type="checkbox">Refundable</label>
<select aria-label="Category"><option>All</option><option>Design</option></select>
<p id="outside">Unrelated offscreen text</p>"""


def main():
    browser = Browser("data:text/html," + quote(HTML))
    passed: list[str] = []
    failures: list[str] = []

    def check(condition: bool, label: str, detail: str = "") -> None:
        if condition:
            passed.append(label)
        else:
            failures.append(f"{label}: {detail}" if detail else label)

    try:
        page = browser.observe(screenshot=False)
        action = next(a for a in page["actions"] if a["label"] == "Continue")
        browser.evaluate("document.querySelector('#target').style.transform='translateX(200px)'")
        moved_is_fresh = browser.fresh(page)  # movement uses fresh geometry, not another model call
        browser.act(action, page)
        check(moved_is_fresh and browser.evaluate("window.clicks") == 1, "moving target clicked at its current spot")

        browser.evaluate("document.querySelector('#outside').textContent='Updated outside the viewport'")
        check(browser.fresh(page), "unrelated offscreen text does not invalidate")

        mutations = {
            "visible context": "document.querySelector('#context').textContent='Cart total: $100'",
            "accessible label": "document.querySelector('#target').setAttribute('aria-label','Delete account')",
            "field property": "document.querySelector('#field').value='London'",
            "checkbox property": "document.querySelector('#toggle').checked=true",
            "disabled target": "document.querySelector('#target').disabled=true",
            "read-only field": "document.querySelector('#field').readOnly=true",
            "hidden target": "document.querySelector('#target').style.display='none'",
            "replaced node": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
            "dropdown option": "document.querySelector('select').options[1].text='Coastal'",
        }
        for label, expression in mutations.items():
            browser.evaluate(
                "document.querySelector('#target').style.display='block'; "
                "document.querySelector('#target').disabled=false"
            )
            page = browser.observe(screenshot=False)
            browser.evaluate(expression)
            check(not browser.fresh(page), label + " invalidates")

        browser.evaluate(
            "document.querySelector('#target').disabled=false; document.querySelector('#target').style.display='block'"
        )
        page = browser.observe(screenshot=False)
        action = next(a for a in page["actions"] if a["label"] == "Delete account")
        # A textless overlay does not alter the model's semantic state, but must block a click.
        browser.evaluate(
            "const cover=document.createElement('div'); "
            "cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; "
            "document.body.append(cover)"
        )
        overlay_fresh = browser.fresh(page)
        try:
            browser.act(action, page)
            blocked = False
        except (RuntimeError, StalePage):
            blocked = True
        check(
            overlay_fresh and blocked and browser.evaluate("window.clicks") == 1,
            "overlay blocked before input",
            f"fresh={overlay_fresh} blocked={blocked}",
        )

        browser.evaluate(
            "document.body.innerHTML="
            + repr("""
          <form><p id="price">Total $10</p>
          <button type="button" id="buy">Buy</button>
          <label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
          <div role="listbox" id="suggestions"></div>
          <label><input id="check" type="checkbox">Enabled</label>
          <label><input id="radio" type="radio">Choice</label>
          <input id="readonly" aria-label="Read only" readonly>
          <input id="secret" type="password" value="never expose this">
          <button id="off" disabled>Disabled</button>
          <select id="category" aria-label="Category">
            <option>All</option><option>Design</option><option disabled>Unavailable</option>
          </select></form><aside id="unrelated">News</aside>
        """)
        )
        page = browser.observe(screenshot=False)
        buy = next(a for a in page["actions"] if a["label"] == "Buy")
        browser.evaluate("document.querySelector('#unrelated').textContent='New unrelated news'")
        check(
            browser.fresh(page, buy) and not browser.fresh(page),
            "click guard accepts unrelated visible updates; terminal guard rejects them",
        )
        for label, expression in {
            "nearby price": "document.querySelector('#price').textContent='Total $100'",
            "form value": "document.querySelector('#query').value='changed'",
            "form toggle": "document.querySelector('#check').checked=true",
            "target replacement": "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
        }.items():
            page = browser.observe(screenshot=False)
            buy = next(a for a in page["actions"] if a["label"] == "Buy")
            browser.evaluate(expression)
            check(not browser.fresh(page, buy), label + " invalidates action-specific guard")

        page = browser.observe(screenshot=False)
        actions = page["actions"]
        controls_ok = (
            all({a["kind"] for a in actions if a.get("role") == role} == {"click"} for role in ("checkbox", "radio"))
            and {a["kind"] for a in actions if a["label"] == "Read only"} == {"click"}
            and not any(a["label"] == "Disabled" or a.get("value") == "never expose this" for a in actions)
            and [a["value"] for a in actions if a["kind"] == "select"] == ["Design"]
        )
        check(controls_ok, "native controls expose only supported operations and safe values")

        select = next(a for a in actions if a["kind"] == "select")
        browser.act(select, page)
        selected = browser.evaluate("document.querySelector('#category').value")
        check(selected == "Design", "native dropdown selects an observed option", repr(selected))

        browser.evaluate(
            "document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{"
            "document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'"
            "},60))"
        )
        page = browser.observe(screenshot=False)
        field = next(a for a in page["actions"] if a["kind"] == "fill")
        browser.act(field, page, text="Generated")
        page = browser.observe(screenshot=False)
        value = browser.evaluate("document.querySelector('#query').value")
        check(
            value == "Generated" and any(a.get("role") == "option" for a in page["actions"]),
            "real text input waits for asynchronous combobox suggestions",
            repr(value),
        )
        browser.call("Page.navigate", url="about:blank")
        check(not browser.fresh(page, field), "navigation invalidates the old document")
    finally:
        browser.close()
    print("\n".join(passed))
    if failures:
        raise AssertionError("browser guard checks failed:\n  " + "\n  ".join(failures))
    print(f"PASS: {len(passed)} browser guard checks; no model calls")


if __name__ == "__main__":
    main()
