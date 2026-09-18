import { describe, expect, it } from "vitest";
import { saveDraft, loadDraft, type ReportDraft } from "./reportDraft";
import { stashPhotoFile, getStashedPhoto } from "./photoStore";
import { saveFeedCache, loadFeedCache } from "../hooks/feedCache";
import { clearUserScopedLocalState } from "./userScopedState";

const draft: ReportDraft = {
  type: "LOST",
  title: "keys",
  description: "",
  category: "",
  eventDate: "",
  location: { label: "", latitude: null, longitude: null },
  youtubeUrl: "",
  photoId: null,
};

describe("clearUserScopedLocalState", () => {
  it("drops the report draft, stashed photos, and feed caches together", () => {
    saveDraft({ ...draft, photoId: "photo-1" });
    const id = stashPhotoFile(new File(["x"], "x.jpg", { type: "image/jpeg" }));
    saveDraft({ ...draft, photoId: id });
    saveFeedCache("k", {
      items: [],
      total: 1,
      cursor: null,
      scrollTop: 0,
    });

    clearUserScopedLocalState();

    expect(loadDraft()).toBeNull();
    expect(getStashedPhoto(id)).toBeNull();
    expect(loadFeedCache("k")).toBeNull();
  });
});
