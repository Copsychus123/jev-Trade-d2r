"""A constant the documents state with its value must have that value in the code.

`docs/design.md`, `AGENTS.md` and the READMEs name constants and give their numbers ("`STALE_RETRY_LIMIT = 3`",
"`DISK_CACHE_BYTES` ... capped at 50 MB"). A number that drifts away from the code turns the rulebook into a
document that lies, which is the same failure `test_run_budgets.py` and `test_docs_paths.py` guard against - this is
the generic half: any `NAME = <number>` a document states, wherever the name is defined.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = (
    "AGENTS.md",
    "README.md",
    "docs/design.md",
    "docs/Jev-Traderie-安裝操作.md",
    "extension/README.md",
)
# `src/.tmp-jev-chrome` is the dedicated Chrome's profile: it holds other people's extensions and none of our code.
SKIP = (".build", "vendor", ".tmp", "node_modules", "dist")

STATED = re.compile(r"([A-Z][A-Z0-9_]{2,})\s*=\s*(\d+(?:\.\d+)?)")
DEFINED = re.compile(r"^\s*(?:export\s+)?(?:const\s+)?([A-Z][A-Z0-9_]{2,})\s*(?::[^=\n]+)?=\s*(\d+(?:\.\d+)?)\b")


def _code_files():
    for base, patterns in (
        (ROOT / "src", "*.py"),
        (ROOT / "services", "*.py"),
        (ROOT / "extension" / "src", "*.js"),
        (ROOT / "scripts", "*.py"),
    ):
        for path in base.rglob(patterns):
            if not any(skip in path.as_posix() for skip in SKIP):
                yield path


def _definitions() -> dict[str, tuple[str, str]]:
    """`NAME -> (value, where)`, first definition wins: a constant named in a document is looked up once."""
    found: dict[str, tuple[str, str]] = {}
    for path in _code_files():
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            match = DEFINED.match(line)
            if match and match.group(1) not in found:
                found[match.group(1)] = (match.group(2), path.relative_to(ROOT).as_posix())
    return found


def test_every_constant_a_document_states_has_that_value_in_the_code():
    definitions = _definitions()
    checked, mismatches, unknown = 0, [], []
    for document in DOCUMENTS:
        text = (ROOT / document).read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), 1):
            for name, stated in STATED.findall(line):
                if name not in definitions:
                    unknown.append(f"{document}:{number} {name} = {stated}")
                    continue
                checked += 1
                actual, where = definitions[name]
                if actual != stated:
                    mismatches.append(f"{document}:{number} says {name} = {stated}, but {where} defines {actual}")
    # Eleven references are stated today; the point of the floor is that a document which stopped naming constants
    # would otherwise make this test pass while measuring nothing.
    assert checked >= 10, f"only {checked} constants were checked"
    assert not mismatches, "documents state numbers the code does not have:\n" + "\n".join(mismatches)
    # A name nobody defines is either a typo in the document or a constant that was deleted from the code.
    assert not unknown, "documents name constants the code does not define:\n" + "\n".join(unknown)


def _code_number(path: str, pattern: str) -> float:
    """The number a source file declares with `pattern` (one capture group); fails loudly when the line is gone."""
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(pattern, text)
    assert match, f"{path} no longer declares {pattern!r}"
    return float(match.group(1).replace("_", ""))


def _doc_number(document: str, pattern: str) -> float:
    """The number a document states in prose with `pattern`; fails loudly when the sentence was reworded away."""
    text = (ROOT / document).read_text(encoding="utf-8")
    match = re.search(pattern, text)
    assert match, f"{document} no longer states {pattern!r}"
    return float(match.group(1))


# The same guarantee as above, for numbers the documents state in words rather than as `NAME = n`: each of these is a
# rule a reader acts on, so a drift is a document that lies about behaviour.
def test_the_publish_gate_is_the_share_the_rulebook_states():
    assert round(_code_number("scripts/build_item_tables.py", r"MAX_SHRINK = ([\d.]+)") * 100) == _doc_number(
        "AGENTS.md", r"or shrank by more than (\d+)%"
    )


def test_the_table_age_that_counts_as_stale_is_the_days_the_rulebook_states():
    assert _code_number("extension/src/traderie/lookup.js", r"TABLE_STALE_DAYS = (\d+)") == _doc_number(
        "AGENTS.md", r"stale after (\d+) days"
    )


def test_the_ocr_workers_idle_termination_is_the_duration_the_rulebook_states():
    assert _code_number("extension/src/ocr/engine.js", r"ENGINE_IDLE_MS = ([\d_]+)") / 1000 == _doc_number(
        "AGENTS.md", r"terminated after about (\d+) s without a read"
    )


def test_the_affix_dictionary_holds_the_entry_count_the_design_document_states():
    text = (ROOT / "extension/src/ocr/affix_dictionary.js").read_text(encoding="utf-8")
    entries = re.findall(r'^\s*affix\("', text, re.M)  # the file is an array of affix(...) calls
    assert len(entries) >= 20, f"only {len(entries)} entries found: the file's shape changed"
    assert len(entries) == _doc_number("docs/design.md", r"affix dictionary keeps (\d+) entries")
