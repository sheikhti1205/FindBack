import type { Category, PostType } from "@findback/shared";
import type { LocationValue } from "../components/LocationPicker";

/** In-app report draft: survives navigation (Help, map helper, model setup). */
export interface ReportDraft {
  type: PostType;
  title: string;
  description: string;
  category: Category | "";
  eventDate: string;
  location: LocationValue;
  youtubeUrl: string;
}

let draft: ReportDraft | null = null;

export function saveDraft(d: ReportDraft): void {
  draft = { ...d, location: { ...d.location } };
}

export function loadDraft(): ReportDraft | null {
  return draft ? { ...draft, location: { ...draft.location } } : null;
}

export function clearDraft(): void {
  draft = null;
}

/** True when the draft holds anything worth confirming before discard. */
export function draftIsMeaningful(d: ReportDraft | null): boolean {
  if (!d) return false;
  return Boolean(
    d.title.trim() || d.description.trim() || d.category || d.location.label.trim() || d.youtubeUrl.trim(),
  );
}
