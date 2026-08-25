"""
Turn class rolls into the Roster tab for the attendance Sheet.

Reads two formats, with no third-party package:

  * Blackboard grade centre export (.csv), with columns
    "Last Name","First Name","Username","Student ID" and IDs like M10933995
  * SAP class roll export (.xlsx), with Name, Student Number, Email

Usage:
    python make_roster.py \
        "FINA3000-02=E:/Teaching/00_FIN331_FALL2026/SEC2/grades/FINA3000SEC2.csv" \
        "FINA3000-07=E:/Teaching/00_FIN331_FALL2026/SEC7/Grades/FINA3000SEC7.csv"

It writes roster.csv next to this script with the columns the Apps Script
expects: Class, StudentID, Name, Email.

Open roster.csv, copy every row under the header, and paste it into the Roster
tab of the Sheet. Then press "Reload roster" on admin.html.
"""

import argparse
import csv
import html
import re
import sys
import zipfile
from pathlib import Path

# ---------- xlsx reading ----------

CELL_RE = re.compile(r"<c\b[^>]*?(?:/>|>.*?</c>)", re.S)
REF_RE = re.compile(r'\br="([A-Z]+)(\d+)"')
TYPE_RE = re.compile(r'\st="([^"]+)"')
VAL_RE = re.compile(r"<v>(.*?)</v>", re.S)
INLINE_RE = re.compile(r"<is>(.*?)</is>", re.S)
TAG_RE = re.compile(r"<[^>]+>")


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    raw = zf.read("xl/sharedStrings.xml").decode("utf-8")
    return [html.unescape(TAG_RE.sub("", si))
            for si in re.findall(r"<si>(.*?)</si>", raw, re.S)]


def read_xlsx(path):
    with zipfile.ZipFile(path) as zf:
        shared = shared_strings(zf)
        name = next(n for n in zf.namelist()
                    if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        sheet = zf.read(name).decode("utf-8")

    for row_xml in re.findall(r"<row\b[^>]*>(.*?)</row>", sheet, re.S):
        cells = {}
        for cell in CELL_RE.findall(row_xml):
            ref = REF_RE.search(cell)
            if not ref:
                continue
            idx = col_index(ref.group(1))
            ctype = TYPE_RE.search(cell)
            ctype = ctype.group(1) if ctype else "n"
            if ctype == "inlineStr":
                m = INLINE_RE.search(cell)
                text = html.unescape(TAG_RE.sub("", m.group(1))) if m else ""
            else:
                m = VAL_RE.search(cell)
                text = m.group(1) if m else ""
                if ctype == "s" and text:
                    text = shared[int(text)]
                text = html.unescape(text)
            cells[idx] = text.strip()
        if not cells:
            continue
        yield [cells.get(i, "") for i in range(max(cells) + 1)]


def read_csv_rows(path):
    # utf-8-sig strips the byte order mark that Blackboard writes.
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            yield [c.strip() for c in row]


def read_rows(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".xlsx":
        return list(read_xlsx(path))
    if suffix in (".csv", ".txt"):
        return list(read_csv_rows(path))
    sys.exit(f"{path}: unsupported file type '{suffix}'. Give a .csv or .xlsx.")


# ---------- header detection ----------

HEADERS = {
    "last": ("last name", "lastname", "last"),
    "first": ("first name", "firstname", "first"),
    "name": ("name", "student name", "full name"),
    "id": ("student id", "student number", "studentid", "id", "sid"),
    "email": ("email", "e-mail", "email address"),
    "username": ("username", "user name", "webid"),
}

# Blackboard exports a WebID, not an address. Ole Miss student mail is
# <webid>@go.olemiss.edu, which the spring roll confirms.
EMAIL_DOMAIN = "@go.olemiss.edu"


def find_header(rows):
    """The header row is the first one naming an ID plus some form of name."""
    for i, row in enumerate(rows):
        lowered = [c.strip().lower() for c in row]
        found = {}
        for field, options in HEADERS.items():
            for j, cell in enumerate(lowered):
                if cell in options:
                    found[field] = j
                    break
        has_name = "name" in found or ("last" in found and "first" in found)
        if has_name and "id" in found:
            return i, found
    return None, None


def load(path, class_id):
    rows = read_rows(path)
    header_at, cols = find_header(rows)
    if header_at is None:
        sys.exit(f"{path}: no header row with a student ID and a name column.")

    out = []
    for row in rows[header_at + 1:]:
        def get(field):
            j = cols.get(field)
            return row[j].strip() if j is not None and j < len(row) else ""

        # The M prefix on a Blackboard ID is dropped. The check-in page strips
        # non-digits too, so a student may type the ID either way.
        student_id = re.sub(r"\D", "", get("id"))

        if "name" in cols:
            name = get("name")
        else:
            last, first = get("last"), get("first")
            name = ", ".join(p for p in (last, first) if p)

        email = get("email")
        if not email and get("username"):
            email = get("username") + EMAIL_DOMAIN

        if not student_id or not name:
            continue
        out.append([class_id, student_id, name, email])
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pairs", nargs="+", metavar="CLASS_ID=ROLL_FILE",
                    help="One pair per class, e.g. FINA3000-02=SEC2/roll.csv")
    ap.add_argument("-o", "--out", default=str(Path(__file__).parent / "roster.csv"))
    args = ap.parse_args()

    rows = []
    for pair in args.pairs:
        if "=" not in pair:
            sys.exit(f"'{pair}' is not a CLASS_ID=ROLL_FILE pair.")
        class_id, roll = pair.split("=", 1)
        class_id = class_id.strip().upper()
        if not Path(roll).exists():
            sys.exit(f"{roll}: no such file.")
        got = load(roll, class_id)
        print(f"{class_id}: {len(got)} students from {Path(roll).name}")
        rows.extend(got)

    counts = {}
    for class_id, student_id, name, _ in rows:
        counts.setdefault((class_id, student_id), []).append(name)
    for keyed, names in counts.items():
        if len(names) > 1:
            print(f"  warning: ID {keyed[1]} appears {len(names)} times in {keyed[0]}")

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Class", "StudentID", "Name", "Email"])
        w.writerows(rows)

    print(f"wrote {len(rows)} rows to {args.out}")
    print("Paste every row under the header into the Roster tab, "
          "then press Reload roster on admin.html.")


if __name__ == "__main__":
    main()
