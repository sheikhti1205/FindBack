// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PublicWelcome } from "./PublicWelcome";
import { isOnboardingComplete } from "../services/onboarding";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(cleanup);
function welcome() {
  return render(<MemoryRouter><Routes>
    <Route path="/" element={<PublicWelcome />} />
    <Route path="/auth" element={<h1>Intentional authentication</h1>} />
  </Routes></MemoryRouter>);
}
it("reuses the editorial opening and exposes truthful chapters and canonical legal links", () => {
  welcome();
  expect(screen.getByRole("heading", { name: "Lost something?" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "A possible match is just that." })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
  expect(screen.getByText(/current site remains findbackapp.social/i)).toBeTruthy();
});
it("signs in deliberately without claiming onboarding was completed", () => {
  welcome();
  fireEvent.click(screen.getByRole("link", { name: "Sign in" }));
  expect(screen.getByRole("heading", { name: "Intentional authentication" })).toBeTruthy();
  expect(isOnboardingComplete()).toBe(false);
});
it("keeps previous scenes and vertical content available and completes only on Skip/Get started", () => {
  welcome();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(isOnboardingComplete()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(isOnboardingComplete()).toBe(true);
  expect(screen.getByRole("heading", { name: "Intentional authentication" })).toBeTruthy();
});
