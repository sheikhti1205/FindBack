// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentMediaPreview } from "./CommentMediaPreview";
const { sign, auth } = vi.hoisted(() => ({ sign: vi.fn(), auth: {
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "reader" } } as { user: { id: string } } | null } })),
  onAuthStateChange: vi.fn((_callback: (event: string, session: null) => void) => ({ data: { subscription: { unsubscribe() {} } } })),
} }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth,
    storage: { from: () => ({ createSignedUrl: sign }) },
  }),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it("uses authorized private bytes in comment thumbnails, never the stored address", async () => {
  sign.mockResolvedValue({ data: { signedUrl: "https://signed.test/comment.jpg" }, error: null });
  const url="https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/authenticated/findback-comment-media/11111111-1111-4111-8111-111111111111/photo.jpg";
  render(<CommentMediaPreview media={{ kind: "photo", url, alt: "Attached photo" }} />);
  expect(screen.getByAltText("Attached photo").getAttribute("src")).toBeNull();
  await waitFor(() => expect(screen.getByAltText("Attached photo").getAttribute("src")).toBe("https://signed.test/comment.jpg"));
});

it.each([false, true])("preserves legacy video position/rate and paused=%s through URL renewal, but not sign-out", async (paused) => {
  vi.useFakeTimers();
  const play=vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
  const load=vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
  sign.mockResolvedValue({data:{signedUrl:"https://signed.test/clip.mp4?generation=1"},error:null});
  auth.getSession.mockResolvedValue({data:{session:{user:{id:"reader"}}}});
  const url="https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/authenticated/findback-comment-media/11111111-1111-4111-8111-111111111111/clip.mp4";
  const view=render(<CommentMediaPreview media={{kind:"video",url,alt:"Historical clip"}}/>);
  await act(async()=>{});
  const video=view.container.querySelector("video")!;
  expect(video.getAttribute("src")).toContain("generation=1");
  video.currentTime=37.25; video.playbackRate=1.25;
  vi.spyOn(video,"paused","get").mockReturnValue(paused);
  sign.mockResolvedValue({data:{signedUrl:"https://signed.test/clip.mp4?generation=2"},error:null});
  await act(async()=>{await vi.advanceTimersByTimeAsync(45_000);});
  expect(video.getAttribute("src")).toContain("generation=2");
  // Native resource selection resets position/rate when src changes; jsdom
  // does not implement that lifecycle, so model the reset before metadata.
  video.currentTime=0;video.playbackRate=1;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(37.25);
  expect(video.playbackRate).toBe(1.25);
  expect(play).toHaveBeenCalledTimes(paused?0:1);
  auth.getSession.mockResolvedValue({data:{session:null}});
  const callback=auth.onAuthStateChange.mock.calls.at(-1)![0] as (event:string,session:null)=>void;
  await act(async()=>{callback("SIGNED_OUT",null);});
  expect(video.getAttribute("src")).toBeNull();
  expect(load).toHaveBeenCalled();
  fireEvent.loadedMetadata(video);
  expect(play).toHaveBeenCalledTimes(paused?0:1);
});
