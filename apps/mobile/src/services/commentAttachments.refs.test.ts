import { describe, expect, it } from "vitest";
import { mapCommentAttachmentRefs } from "./commentAttachments";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";

describe("mapCommentAttachmentRefs", () => {
  it("treats a missing or non-array field as no descriptors", () => {
    expect(mapCommentAttachmentRefs(undefined)).toEqual([]);
    expect(mapCommentAttachmentRefs(null)).toEqual([]);
    expect(mapCommentAttachmentRefs({ kind: "report" })).toEqual([]);
    expect(mapCommentAttachmentRefs("report")).toEqual([]);
  });

  it("keeps a report pointer with its display order", () => {
    expect(
      mapCommentAttachmentRefs([
        { kind: "report", display_order: 2, report_post_id: REPORT_ID },
      ]),
    ).toEqual([{ kind: "report", reportPostId: REPORT_ID, displayOrder: 2 }]);
  });

  it("keeps a NULL pointer as ONE tombstone entry, never zero entries", () => {
    // The deleted-target row (FK ON DELETE SET NULL) stays readable server-side
    // and the list RPC returns it; the client's whole job is to render it.
    expect(
      mapCommentAttachmentRefs([{ kind: "report", display_order: 1, report_post_id: null }]),
    ).toEqual([{ kind: "report", reportPostId: null, displayOrder: 1 }]);
  });

  it("treats an absent, empty or non-string pointer as the same tombstone", () => {
    const refs = mapCommentAttachmentRefs([
      { kind: "report", display_order: 1 },
      { kind: "report", display_order: 2, report_post_id: "" },
      { kind: "report", display_order: 3, report_post_id: 42 },
    ]);
    expect(refs).toEqual([
      { kind: "report", reportPostId: null, displayOrder: 1 },
      { kind: "report", reportPostId: null, displayOrder: 2 },
      { kind: "report", reportPostId: null, displayOrder: 3 },
    ]);
  });

  it("leaves a pointer on a media row inert (M2 D6: the client is the mitigation)", () => {
    expect(
      mapCommentAttachmentRefs([
        { kind: "photo", display_order: 1, report_post_id: REPORT_ID, remote_url: "https://cdn.test/a.jpg" },
        { kind: "video", display_order: 2, report_post_id: REPORT_ID },
        { kind: "gif", display_order: 3, report_post_id: null },
        { kind: "sticker", display_order: 4 },
      ]),
    ).toEqual([]);
  });

  it("skips a null or non-object element instead of throwing on it", () => {
    const refs = mapCommentAttachmentRefs([
      null,
      "report",
      { kind: "report", display_order: 2, report_post_id: REPORT_ID },
      7,
    ]);
    expect(refs).toEqual([{ kind: "report", reportPostId: REPORT_ID, displayOrder: 2 }]);
  });

  it("falls back to the row's own slot when display_order is absent", () => {
    expect(
      mapCommentAttachmentRefs([
        { kind: "photo", display_order: 1 },
        { kind: "report" },
        { kind: "report", display_order: 3 },
      ]),
    ).toEqual([
      { kind: "report", reportPostId: null, displayOrder: 2 },
      { kind: "report", reportPostId: null, displayOrder: 3 },
    ]);
  });

  it("preserves ordered slots, including a tombstone in the middle", () => {
    const refs = mapCommentAttachmentRefs([
      { kind: "report", display_order: 3, report_post_id: REPORT_ID },
      { kind: "photo", display_order: 1 },
      { kind: "report", display_order: 2, report_post_id: null },
    ]);
    expect(refs).toEqual([
      { kind: "report", reportPostId: REPORT_ID, displayOrder: 3 },
      { kind: "report", reportPostId: null, displayOrder: 2 },
    ]);
  });
});
