// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PeerChatComposer } from "./PeerChatComposer";

afterEach(cleanup);
function mount(connected = true) {
  const photo = vi.fn(), location = vi.fn();
  render(<PeerChatComposer value="Keep draft" onChange={() => {}} onSend={() => {}}
    inputRef={createRef()} busy={false} locked={false} canSend={true} photoAllowed={connected}
    onPhoto={photo} locationAllowed={connected} onLocation={location} />);
  return { photo, location };
}
it("uses one peer add menu with Photo and Location only", async () => {
  const f = mount(); fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
  expect(await screen.findByRole("menuitem", { name: "Photo" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Location" }));
  expect(f.location).toHaveBeenCalledTimes(1); expect(f.photo).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep draft");
  fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Photo" })); expect(f.photo).toHaveBeenCalledTimes(1);
});
it("does not offer media or location in a request", () => {
  mount(false); expect(screen.queryByRole("button", { name: "Add to message" })).toBeNull();
});
