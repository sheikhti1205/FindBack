"""Behavior tests for provisional metadata conversion, not history approval."""

import csv
import io
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("generate-history-inventory.py")
SOURCE_FIELDS = [
    "revision_id_provisional", "commit_sha", "parent_shas_in_order",
    "author_date_original", "subject_original", "root_package_version_declared",
    "mobile_package_version_declared", "product_version_assignment",
]
OUTPUT_FIELDS = [
    "revision", "commit_sha", "original_commit_sha", "product_version", "phase",
    "tag", "release", "authored_at", "summary", "notes",
]


def row(number=1, sha="a" * 40, parents=""):
    return dict(zip(SOURCE_FIELDS, [
        f"r{number:04d}", sha, parents, "2026-09-09T22:45:31+06:00",
        'feat: a comma, a "quote" and\na second line', "1.0.0", "1.0.0",
        "1.0.0 stable (unverified source assertion)",
    ]))


def convert(rows, fields=SOURCE_FIELDS):
    source = io.StringIO(newline="")
    writer = csv.DictWriter(source, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return subprocess.run(
        [sys.executable, str(SCRIPT)], input=source.getvalue(),
        capture_output=True, text=True, check=False,
    )


class HistoryInventoryTest(unittest.TestCase):
    def test_metadata_conversion_preserves_identity_and_rfc4180_text(self):
        original = row()
        result = convert([original])
        self.assertEqual(result.returncode, 0, result.stderr)
        reader = csv.DictReader(io.StringIO(result.stdout))
        self.assertEqual(reader.fieldnames, OUTPUT_FIELDS)
        actual, = list(reader)
        self.assertEqual(actual["revision"], original["revision_id_provisional"])
        self.assertEqual(actual["commit_sha"], original["commit_sha"])
        self.assertEqual(actual["original_commit_sha"], original["commit_sha"])
        self.assertEqual(actual["authored_at"], original["author_date_original"])
        self.assertEqual(actual["summary"], original["subject_original"])

    def test_source_stable_assertion_never_becomes_reconstructed_version(self):
        result = convert([row()])
        self.assertEqual(result.returncode, 0, result.stderr)
        actual, = list(csv.DictReader(io.StringIO(result.stdout)))
        self.assertEqual(actual["product_version"], "UNASSIGNED")
        self.assertEqual(actual["phase"], "UNASSIGNED")
        self.assertEqual(actual["tag"], "")
        self.assertEqual(actual["release"], "")
        self.assertIn("no rewrite", actual["notes"])
        self.assertIn("not hosted migration evidence", actual["notes"])
        self.assertIn("declared root=1.0.0; mobile=1.0.0", actual["notes"])

    def test_parent_before_child_order_is_preserved_not_sorted_by_dates(self):
        second = row(2, "b" * 40, "a" * 40)
        second["author_date_original"] = "2026-09-08T10:00:00+00:00"
        result = convert([row(), second])
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = list(csv.DictReader(io.StringIO(result.stdout)))
        self.assertEqual([x["commit_sha"] for x in actual], ["a" * 40, "b" * 40])
        self.assertEqual(actual[1]["authored_at"], second["author_date_original"])

    def test_invalid_metadata_fails_without_partial_csv_output(self):
        cases = {
            "empty": [],
            "duplicate SHA": [row(), row(2)],
            "revision gap": [row(), row(3, "b" * 40, "a" * 40)],
            "forward parent": [row(parents="b" * 40), row(2, "b" * 40)],
            "missing parent": [row(parents="c" * 40)],
            "malformed SHA": [row(sha="not-a-sha")],
            "empty date": [{**row(), "author_date_original": ""}],
            "invalid date": [{**row(), "author_date_original": "yesterday"}],
            "naive date": [{**row(), "author_date_original": "2026-09-09T22:00:00"}],
        }
        for name, rows in cases.items():
            with self.subTest(name=name):
                result = convert(rows)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("Invalid inventory", result.stderr)

    def test_merge_parents_use_frozen_inventory_semicolon_encoding(self):
        result = convert([
            row(), row(2, "b" * 40, "a" * 40),
            row(3, "c" * 40, "a" * 40 + ";" + "b" * 40),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = list(csv.DictReader(io.StringIO(result.stdout)))
        self.assertEqual([x["revision"] for x in actual], ["r0001", "r0002", "r0003"])

    def test_missing_required_column_is_rejected(self):
        original = row()
        del original["parent_shas_in_order"]
        result = convert([original], list(original))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("parent_shas_in_order", result.stderr)

    def test_duplicate_headers_and_ragged_rows_are_rejected(self):
        valid = io.StringIO(newline="")
        writer = csv.DictWriter(valid, fieldnames=SOURCE_FIELDS)
        writer.writeheader()
        writer.writerow({**row(), "subject_original": "simple subject"})
        header, data = valid.getvalue().splitlines()
        for source in [
            header + ",commit_sha\n" + data + "," + "a" * 40 + "\n",
            header + "\n" + data + ",extra\n",
            header + "\n" + ",".join(data.split(",")[:-1]) + "\n",
        ]:
            with self.subTest(source=source):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT)], input=source,
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("Invalid inventory", result.stderr)


if __name__ == "__main__":
    unittest.main()
