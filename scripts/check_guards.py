"""Local-browser freshness/execution regressions. No model calls or external websites."""

import time
from urllib.parse import quote

from jev_ultrafast.browser import Browser, StalePage

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
    passed = []
    try:
        page = browser.observe(screenshot=False)
        action = next(a for a in page["actions"] if a["label"] == "Continue")
        browser.evaluate("document.querySelector('#target').style.transform='translateX(200px)'")
        assert browser.fresh(page), "Movement should use fresh geometry, not another model call"
        browser.act(action, page)
        assert browser.evaluate("window.clicks") == 1
        passed.append("moving target clicked at its current location")

        browser.evaluate("document.querySelector('#outside').textContent='Updated outside the viewport'")
        assert browser.fresh(page)
        passed.append("unrelated offscreen text does not invalidate")

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
            browser.evaluate("document.querySelector('#target').style.display='block'; "
                             "document.querySelector('#target').disabled=false")
            page = browser.observe(screenshot=False)
            browser.evaluate(expression)
            assert not browser.fresh(page), label
            passed.append(label + " invalidates")

        browser.evaluate("document.querySelector('#target').disabled=false; "
                         "document.querySelector('#target').style.display='block'")
        page = browser.observe(screenshot=False)
        action = next(a for a in page["actions"] if a["label"] == "Delete account")
        # A textless overlay does not alter the model's semantic state, but must block a click.
        browser.evaluate("const cover=document.createElement('div'); "
                         "cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; "
                         "document.body.append(cover)")
        assert browser.fresh(page)
        try:
            browser.act(action, page)
        except (RuntimeError, StalePage):
            pass
        else:
            raise AssertionError("Covered target was clicked")
        assert browser.evaluate("window.clicks") == 1
        passed.append("overlay blocked before input")

        browser.evaluate("document.body.innerHTML=" + repr("""
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
        """))
        page = browser.observe(screenshot=False)
        buy = next(a for a in page["actions"] if a["label"] == "Buy")
        browser.evaluate("document.querySelector('#unrelated').textContent='New unrelated news'")
        assert browser.fresh(page, buy)
        assert not browser.fresh(page)
        passed.append("click guard accepts unrelated visible updates; terminal guard rejects them")
        for label, expression in {
            "nearby price": "document.querySelector('#price').textContent='Total $100'",
            "form value": "document.querySelector('#query').value='changed'",
            "form toggle": "document.querySelector('#check').checked=true",
            "target replacement": "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
        }.items():
            page = browser.observe(screenshot=False)
            buy = next(a for a in page["actions"] if a["label"] == "Buy")
            browser.evaluate(expression)
            assert not browser.fresh(page, buy), label
            passed.append(label + " invalidates action-specific guard")

        page = browser.observe(screenshot=False)
        actions = page["actions"]
        for role in ("checkbox", "radio"):
            assert {a["kind"] for a in actions if a.get("role") == role} == {"click"}
        assert {a["kind"] for a in actions if a["label"] == "Read only"} == {"click"}
        assert not any(a["label"] == "Disabled" or a.get("value") == "never expose this" for a in actions)
        assert [a["value"] for a in actions if a["kind"] == "select"] == ["Design"]
        passed.append("native controls expose only supported operations and safe values")

        select = next(a for a in actions if a["kind"] == "select")
        browser.act(select, page)
        assert browser.evaluate("document.querySelector('#category').value") == "Design"
        passed.append("native dropdown selects an observed option")

        browser.evaluate("document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{"
                         "document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'"
                         "},60))")
        page = browser.observe(screenshot=False)
        field = next(a for a in page["actions"] if a["kind"] == "fill")
        browser.act(field, page, text="Generated")
        page = browser.observe(screenshot=False)
        value = browser.evaluate("document.querySelector('#query').value")
        assert value == "Generated", repr(value)
        assert any(a.get("role") == "option" for a in page["actions"])
        passed.append("real text input waits for asynchronous combobox suggestions")

        rows = "".join(
            f'<label class="row"><input type="checkbox" name="al" value="{i}">Airline {i}</label>'
            + ('<button type="button" class="row">More filters</button>' if i == 6 else '')
            for i in range(1, 21)
        )
        rows += '<button type="button" class="row">Apply extra</button>'
        browser.evaluate("document.body.innerHTML=" + repr(f"""
          <style>
            #airlines {{ position:absolute; left:8px; top:8px; width:260px; height:140px;
              overflow:auto; border:1px solid #000; background:#fff; }}
            #airlines .row {{ display:block; position:relative; height:28px; line-height:28px; }}
            #airlines input[type=checkbox] {{
              opacity:0; position:absolute; inset:0; width:100%; height:100%; margin:0;
            }}
            #clip {{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }}
            #pagefill {{ height:4000px; }}
          </style>
          <div role="dialog" id="airlines" aria-label="Airlines">
            <input type="radio" id="clip" name="stops">
            <label for="clip">Nonstop</label>
            {rows}
          </div>
          <div id="pagefill">page filler</div>
        """))
        page = browser.observe(screenshot=False)
        checks = [a for a in page["actions"] if a.get("role") == "checkbox"]
        radio = next(a for a in page["actions"] if a.get("role") == "radio")
        labels = {a.get("label") for a in page["actions"]}
        assert {a["label"] for a in checks} >= {"Airline 1", "Airline 20"}
        assert "More filters" not in labels and "Apply extra" not in labels
        assert all("checked" in a for a in checks)
        assert radio["label"] == "Nonstop" and radio["checked"] == "false"
        passed.append("opacity-0 checkboxes and clipped radio are indexed")

        first = next(a for a in checks if a["label"] == "Airline 1")
        browser.act(first, page)
        assert browser.evaluate("document.querySelector('input[value=\"1\"]').checked") is True
        passed.append("clicking an opacity-0 checkbox toggles it")

        started = time.monotonic()
        page = browser.observe(screenshot=False)
        assert time.monotonic() - started >= 0.7
        passed.append("checkbox click waits for filter chips")
        far = next(a for a in page["actions"] if a.get("label") == "Airline 20")
        y0 = browser.evaluate("window.scrollY")
        top0 = browser.evaluate("document.querySelector('#airlines').scrollTop")
        browser.act(far, page)
        assert browser.evaluate("document.querySelector('input[value=\"20\"]').checked") is True
        assert browser.evaluate("document.querySelector('#airlines').scrollTop") > top0
        assert browser.evaluate("window.scrollY") == y0
        passed.append("clipped checkbox click scrolls its overflow ancestor")

        browser.evaluate("document.querySelector('#airlines').scrollTop=0")
        page = browser.observe(screenshot=False)
        dialog_scroll = next(
            a for a in page["actions"]
            if a["kind"] == "scroll" and a.get("direction") == "down" and a.get("node") is not None
        )
        page_scroll = next(
            a for a in page["actions"]
            if a["kind"] == "scroll" and a.get("direction") == "down" and a.get("node") is None
        )
        assert "Airlines" in dialog_scroll["label"]
        assert 48 <= dialog_scroll["delta"] <= 140
        assert page_scroll["delta"] == 560
        assert not any(a.get("label") in {"More filters", "Apply extra"} for a in page["actions"])
        browser.act(dialog_scroll, page)
        page = browser.observe(screenshot=False)
        labels = {a.get("label") for a in page["actions"]}
        assert "More filters" in labels
        assert "Apply extra" not in labels
        passed.append("container scroll uses a short delta and still clips buttons")

        top = browser.evaluate("document.querySelector('#airlines').scrollTop")
        page_scroll = next(
            a for a in page["actions"]
            if a["kind"] == "scroll" and a.get("direction") == "down" and a.get("node") is None
        )
        browser.act(page_scroll, page)
        assert browser.evaluate("document.querySelector('#airlines').scrollTop") == top
        passed.append("document scroll does not move the dialog")

        hidden_rows = "".join(
            f'<label class="row"><input type="checkbox" name="hid" value="{i}">Hidden {i}</label>'
            for i in range(1, 21)
        )
        browser.evaluate("document.body.innerHTML=" + repr(f"""
          <style>
            #hidden-list {{ position:absolute; left:8px; top:8px; width:260px; height:140px;
              overflow:hidden; border:1px solid #000; background:#fff; }}
            #hidden-list .row {{ display:block; position:relative; height:28px; line-height:28px; }}
            #hidden-list input[type=checkbox] {{
              opacity:0; position:absolute; inset:0; width:100%; height:100%; margin:0;
            }}
          </style>
          <div role="dialog" id="hidden-list" aria-label="Airlines">{hidden_rows}</div>
        """))
        page = browser.observe(screenshot=False)
        hidden_checks = {a["label"] for a in page["actions"] if a.get("role") == "checkbox"}
        assert "Hidden 1" in hidden_checks and "Hidden 20" in hidden_checks
        hidden_scroll = next(
            a for a in page["actions"]
            if a["kind"] == "scroll" and a.get("direction") == "down" and a.get("node") is not None
        )
        top0 = browser.evaluate("document.querySelector('#hidden-list').scrollTop")
        browser.act(hidden_scroll, page)
        assert browser.evaluate("document.querySelector('#hidden-list').scrollTop") > top0
        passed.append("overflow:hidden list scroll moves scrollTop")

        browser.evaluate("document.querySelector('#hidden-list').scrollTop=0")
        page = browser.observe(screenshot=False)
        far = next(a for a in page["actions"] if a.get("label") == "Hidden 20")
        top0 = browser.evaluate("document.querySelector('#hidden-list').scrollTop")
        browser.act(far, page)
        assert browser.evaluate("document.querySelector('input[value=\"20\"]').checked") is True
        assert browser.evaluate("document.querySelector('#hidden-list').scrollTop") > top0
        passed.append("overflow:hidden checkbox rows index and reveal")

        browser.evaluate("""
          const sw=document.createElement('div');
          sw.setAttribute('role','switch');
          sw.setAttribute('aria-checked','true');
          sw.setAttribute('aria-label','Select all airlines');
          sw.tabIndex=0;
          sw.style.cssText='position:absolute;left:8px;top:160px;width:200px;height:28px';
          sw.addEventListener('click',()=>sw.setAttribute('aria-checked',
            sw.getAttribute('aria-checked')==='true'?'false':'true'));
          document.body.append(sw);
        """)
        page = browser.observe(screenshot=False)
        select_all = next(a for a in page["actions"] if a.get("label") == "Select all airlines")
        assert select_all["checked"] == "true"
        browser.act(select_all, page)
        page = browser.observe(screenshot=False)
        assert not any(a.get("label") == "Select all airlines" for a in page["actions"])
        passed.append("off select-all switch is not a click target")

        browser.evaluate("""
          const dlg=document.createElement('div');
          dlg.setAttribute('role','dialog');
          dlg.setAttribute('aria-label','Airlines');
          dlg.innerHTML='<button type="button">Close dialog</button>'
            +'<div role="checkbox" aria-checked="false" style="width:80px;height:24px">United</div>';
          dlg.style.cssText='position:absolute;left:300px;top:8px;width:220px;height:80px;background:#fff';
          document.body.append(dlg);
        """)
        page = browser.observe(screenshot=False)
        assert not any(a.get("label") == "Close dialog" for a in page["actions"])
        browser.evaluate("document.querySelector('[role=dialog] [role=checkbox]').setAttribute('aria-checked','true')")
        page = browser.observe(screenshot=False)
        assert any(a.get("label") == "Close dialog" for a in page["actions"])
        passed.append("close is omitted until a dialog checkbox is checked")

        browser.call("Page.navigate", url="about:blank")
        assert not browser.fresh(page, field)
        passed.append("navigation invalidates the old document")
    finally:
        browser.close()
    print("\n".join(passed))
    print(f"PASS: {len(passed)} browser guard checks; no model calls")


if __name__ == "__main__":
    main()
