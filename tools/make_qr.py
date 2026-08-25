"""
Draw one check-in QR code per class, for display.html to show on the projector.

The class list comes from docs/config.js, so the QR codes cannot drift out of
step with the pages. Each QR points at a fixed URL and never changes. Only the
six digit code on the screen rotates.

Usage:
    pip install segno
    python make_qr.py https://coccia-sas.github.io/attendance/

It writes docs/qr-<classid>.svg, lower case, one per class.
"""

import re
import sys
from pathlib import Path

try:
    import segno
except ImportError:
    sys.exit("segno is not installed. Run:  pip install segno")

DOCS = Path(__file__).resolve().parent.parent / "docs"
CONFIG = DOCS / "config.js"


def class_ids():
    """Pull the quoted keys out of the classes { ... } block in config.js."""
    text = CONFIG.read_text(encoding="utf-8")
    start = text.find("classes:")
    if start == -1:
        sys.exit(f"{CONFIG}: no 'classes:' block found.")

    depth, i, body_start = 0, text.index("{", start), None
    for i in range(text.index("{", start), len(text)):
        if text[i] == "{":
            if depth == 0:
                body_start = i + 1
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                body = text[body_start:i]
                break
    else:
        sys.exit(f"{CONFIG}: the classes block is not closed.")

    # A class key is a quoted name followed by a colon, at nesting depth 1.
    ids, depth = [], 0
    for match in re.finditer(r"[{}]|'([^']+)'\s*:|\"([^\"]+)\"\s*:", body):
        token = match.group(0)
        if token == "{":
            depth += 1
        elif token == "}":
            depth -= 1
        elif depth == 0:
            ids.append(match.group(1) or match.group(2))
    return ids


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)

    base = sys.argv[1].rstrip("/") + "/"
    ids = class_ids()
    if not ids:
        sys.exit(f"{CONFIG}: found no classes.")

    DOCS.mkdir(parents=True, exist_ok=True)
    keep = set()

    for class_id in ids:
        url = f"{base}index.html?c={class_id}"
        out = DOCS / f"qr-{class_id.lower()}.svg"
        keep.add(out.name)
        # Error correction M survives a projector and a phone held at an angle.
        segno.make(url, error="m").save(
            str(out), scale=10, border=2, dark="#000000", light="#ffffff"
        )
        print(f"{class_id}\n  {url}\n  -> {out}")

    stale = [p for p in DOCS.glob("qr-*.svg") if p.name not in keep]
    for p in stale:
        print(f"stale, no longer in config.js: {p.name}")


if __name__ == "__main__":
    main()
