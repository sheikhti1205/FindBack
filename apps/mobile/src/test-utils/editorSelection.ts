import { act } from "@testing-library/react";

/**
 * Flush the editor's coalesced selection render. The editor batches
 * selection-tick re-renders on requestAnimationFrame (long-press drags fire
 * per-frame updates); tests that change the ProseMirror selection and then
 * read selection-derived UI (e.g. the Link button's disabled state) must
 * await this first. Doc-changing commands re-render synchronously and do not
 * need it.
 */
export async function settleSelectionRender(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  });
}
