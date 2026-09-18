/**
 * In-session store for picked photo Files.
 *
 * A `File` from the web file input only has a `blob:` URL, which dies with the
 * component. The report composer survives navigation to Offline AI / Help, so
 * the File must outlive the screen while staying out of the serialized draft
 * (Files are not JSON). Drafts keep a `photoId`; the File lives here.
 */
const files = new Map<string, File>();
let seq = 0;

export function stashPhotoFile(file: File): string {
  const id = `photo-${Date.now()}-${seq++}`;
  files.set(id, file);
  return id;
}

export function getStashedPhoto(id: string | null | undefined): File | null {
  if (!id) return null;
  return files.get(id) ?? null;
}

export function dropStashedPhoto(id: string | null | undefined): void {
  if (id) files.delete(id);
}

/** Drop every stashed File (e.g. on sign-out). */
export function clearPhotoStore(): void {
  files.clear();
}
