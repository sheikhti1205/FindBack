#!/usr/bin/env python3
"""Render the FindBack ERD as a scalable vector PDF.

Generates docs/erd/ERD.pdf. The diagram shows the eight core tables with
their attributes (PK/FK/UQ tags) plus a relationship map. The authoritative,
editable source remains docs/erd/ERD.md (Mermaid), which GitHub renders.

Run from the repo root:  python3 tools/render_erd.py
Requires:  pip install reportlab
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = Path(__file__).resolve().parent.parent / "docs" / "erd" / "ERD.pdf"

TABLES = {
    "users": [
        ("id", "PK"),
        ("username", "UQ"),
        ("email", "UQ"),
        ("phone", "UQ"),
        ("password_hash", ""),
        ("email_verified", ""),
        ("phone_verified", ""),
        ("avatar_url", ""),
        ("created_at / updated_at", ""),
    ],
    "item_posts": [
        ("id", "PK"),
        ("user_id", "FK"),
        ("type (LOST|FOUND)", ""),
        ("title", ""),
        ("description", ""),
        ("category", ""),
        ("status", ""),
        ("event_date", ""),
        ("latitude / longitude", ""),
        ("location_label", ""),
        ("youtube_url", ""),
        ("created_at / updated_at", ""),
    ],
    "attachments": [
        ("id", "PK"),
        ("post_id", "FK"),
        ("file_url", ""),
        ("mime_type", ""),
        ("file_name", ""),
        ("file_size", ""),
        ("created_at", ""),
    ],
    "comments": [
        ("id", "PK"),
        ("post_id", "FK"),
        ("user_id", "FK"),
        ("body", ""),
        ("created_at / updated_at", ""),
    ],
    "reactions": [
        ("id", "PK"),
        ("post_id", "FK"),
        ("user_id", "FK"),
        ("type (LIKE|DISLIKE)", ""),
        ("created_at", ""),
    ],
    "ratings": [
        ("id", "PK"),
        ("post_id", "FK"),
        ("user_id", "FK"),
        ("score (1..5)", ""),
        ("created_at / updated_at", ""),
    ],
    "verification_challenges": [
        ("id", "PK"),
        ("user_id", "FK"),
        ("channel (EMAIL|PHONE)", ""),
        ("code_hash", ""),
        ("expires_at", ""),
        ("verified_at", ""),
        ("created_at", ""),
    ],
    "uploads": [
        ("id", "PK"),
        ("user_id", "FK"),
        ("file_name", ""),
        ("mime_type", ""),
        ("file_size", ""),
        ("file_url", ""),
        ("created_at", ""),
    ],
}

RELATIONS = [
    ("users", "1 : N", "item_posts", "author of a report"),
    ("users", "1 : N", "comments", "writes comments"),
    ("users", "1 : N", "reactions", "one like/dislike per post+user"),
    ("users", "1 : N", "ratings", "one score per post+user"),
    ("users", "1 : N", "verification_challenges", "OTP audit trail"),
    ("users", "1 : N", "uploads", "file ownership"),
    ("item_posts", "1 : N", "attachments", "photo(s) of the item"),
    ("item_posts", "1 : N", "comments", "discussion"),
    ("item_posts", "1 : N", "reactions", "votes"),
    ("item_posts", "1 : N", "ratings", "scores"),
]

STY = ParagraphStyle(
    "attr",
    fontName="Courier",
    fontSize=6.5,
    leading=8,
    wordWrap="CJK",
)
NAME = ParagraphStyle(
    "name",
    fontName="Helvetica-Bold",
    fontSize=9,
    leading=11,
)
BODY = ParagraphStyle(
    "body",
    fontName="Helvetica",
    fontSize=8,
    leading=10,
)
H1 = ParagraphStyle(
    "h1",
    fontName="Helvetica-Bold",
    fontSize=15,
    leading=18,
)


def attr_cell(text: str, tag: str) -> Paragraph:
    if tag:
        return Paragraph(f'<font color="#7a7a7a">{text}</font> '
                         f'<font color="#c00000" size="5.5">[{tag}]</font>', STY)
    return Paragraph(f"<font color='#1a1a1a'>{text}</font>", STY)


def entity_card(name: str) -> Table:
    rows = [[Paragraph(name, NAME)]] + [[attr_cell(a, t)] for a, t in TABLES[name]]
    t = Table(rows, colWidths=[40 * mm])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a1a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#444444")),
                ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#cccccc")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
            ]
        )
    )
    return t


def build_story():
    parts = [Paragraph("FindBack — Entity Relationship Diagram", H1)]
    parts.append(Paragraph(
        "SQLite schema (node:sqlite, WAL, foreign keys ON). Source of truth: "
        "services/api/src/db/db.ts — Mermaid source in docs/erd/ERD.md.",
        BODY,
    ))
    parts.append(Spacer(1, 2 * mm))

    cards = [entity_card(name) for name in TABLES]
    # 3 x 3 grid of entity cards (upload, item_posts wide last row).
    grid = [
        [cards[0], cards[1], cards[2]],
        [cards[3], cards[4], cards[5]],
        [cards[6], cards[7], Spacer(10 * mm, 40 * mm)],
    ]
    outer = Table(grid)
    outer.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("BACKGROUND", (0, 2), (1, 2), colors.white),
            ]
        )
    )
    parts.append(outer)
    parts.append(Spacer(1, 4 * mm))

    parts.append(Paragraph("Relationships", ParagraphStyle(
        "rh", parent=BODY, fontName="Helvetica-Bold", fontSize=10, spaceAfter=2 * mm)))
    rel_rows = [[Paragraph(f"<b>{a}</b>  {m}  <b>{b}</b>", BODY), Paragraph(d, BODY)]
                for a, m, b, d in RELATIONS]
    rel = Table(rel_rows, colWidths=[120 * mm, 100 * mm])
    rel.setStyle(
        TableStyle(
            [
                ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#dddddd")),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#888888")),
                ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f5f5f5")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    parts.append(rel)
    parts.append(Spacer(1, 3 * mm))
    parts.append(Paragraph(
        "Notes: PK = primary key, FK = foreign key, UQ = unique. reactions.UNIQUE(post_id, user_id) "
        "and ratings.UNIQUE(post_id, user_id) enforce one vote / one rating per user per post. "
        "Deleting an item_post cascades to attachments, comments, reactions and ratings.",
        BODY,
    ))
    return parts


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title="FindBack ERD",
        author="FindBack (Mobile App Development Lab)",
    )
    doc.build(build_story())
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
