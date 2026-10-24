#!/usr/bin/env python3
"""Convert a frozen metadata inventory to the provisional R3 CSV schema.

Reads CSV from stdin and writes CSV to stdout after validating the entire input.
This is NOT a historical diff audit, version assignment or migration verifier.
It never reads Git objects, rewrites history, or infers releases from subjects.
Keep the original inventory privately. Write output to a candidate file first.
"""

import csv
from datetime import datetime
import io
import re
import sys


REQUIRED = {
    "revision_id_provisional", "commit_sha", "parent_shas_in_order",
    "author_date_original", "subject_original", "root_package_version_declared",
    "mobile_package_version_declared",
}
FIELDS = [
    "revision", "commit_sha", "original_commit_sha", "product_version", "phase",
    "tag", "release", "authored_at", "summary", "notes",
]


def convert(source):
    reader = csv.DictReader(source, strict=True)
    headers = reader.fieldnames or []
    missing = REQUIRED - set(headers)
    if missing:
        raise ValueError("missing columns: " + ", ".join(sorted(missing)))
    if len(headers) != len(set(headers)):
        raise ValueError("duplicate columns")
    output = []
    seen = set()
    for number, row in enumerate(reader, 1):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f"row {number}: column count mismatch")
        revision = row["revision_id_provisional"]
        sha = row["commit_sha"]
        if revision != f"r{number:04d}":
            raise ValueError(f"row {number}: non-contiguous revision")
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha in seen:
            raise ValueError(f"row {number}: invalid or duplicate SHA")
        parents = row["parent_shas_in_order"].split(";") if row["parent_shas_in_order"] else []
        if any(parent not in seen for parent in parents):
            raise ValueError(f"row {number}: missing or forward parent")
        date = datetime.fromisoformat(row["author_date_original"])
        if date.utcoffset() is None:
            raise ValueError(f"row {number}: authored date has no timezone")
        seen.add(sha)
        output.append({
            "revision": revision,
            "commit_sha": sha,
            "original_commit_sha": sha,
            "product_version": "UNASSIGNED",
            "phase": "UNASSIGNED",
            "tag": "",
            "release": "",
            "authored_at": row["author_date_original"],
            "summary": row["subject_original"],
            "notes": (
                "PROVISIONAL metadata only; no rewrite; "
                f"declared root={row['root_package_version_declared']}; "
                f"mobile={row['mobile_package_version_declared']}; "
                "milestone and tag/release audit pending; "
                "not hosted migration evidence"
            ),
        })
    if not output:
        raise ValueError("empty inventory")
    result = io.StringIO(newline="")
    writer = csv.DictWriter(result, fieldnames=FIELDS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(output)
    return result.getvalue()


def main():
    try:
        result = convert(sys.stdin)
    except (ValueError, csv.Error) as error:
        # Do not echo input rows or opaque exception text into diagnostics.
        # Missing-column diagnostics contain only our own expected field names.
        if isinstance(error, ValueError) and str(error).startswith("missing columns:"):
            print("Invalid inventory: " + str(error), file=sys.stderr)
        else:
            print("Invalid inventory: malformed metadata or incomplete DAG order", file=sys.stderr)
        return 1
    sys.stdout.write(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
