// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { clearAuthReturnTo, getAuthReturnRoute, rememberAuthReturnTo, safeAuthReturnTo } from "./authReturnTo";

beforeEach(() => sessionStorage.clear());

it.each(["/posts/p1?from=search", "/u/someone", "/chats/c1", "/settings/privacy", "/search?q=black%20wallet", "/notifications", "/about", "/help", "/ai-connection", "/ai-models", "/offline-ai"])("keeps a protected internal destination %s", route => {
  expect(safeAuthReturnTo(route)).toBe(route);
  rememberAuthReturnTo(route);
  expect(getAuthReturnRoute()).toBe(route);
  clearAuthReturnTo();
  expect(getAuthReturnRoute()).toBe("/");
});

it.each(["https://evil.example", "//evil.example", "/\\evil", "/%2fevil", "/posts%2fp1", "/posts/%252e%252e/auth", "/posts/p1%3faccess_token=x", "/auth", "/signin", "/register", "/complete-profile", "/recovery#access_token=x", "/unknown", "/posts/p1\n", "/posts/../auth", "/chats/%2e%2e/auth", "/posts/p1?access_token=private", "/search?q=x%0ay", "/posts/p1?%61ccess_token=x"])("refuses unsafe, auth-loop or credential-bearing destination %s", route => {
  expect(safeAuthReturnTo(route)).toBeNull();
  rememberAuthReturnTo(route);
  expect(getAuthReturnRoute()).toBe("/");
});

it("expires protected intent and does not consume it before arrival", () => {
  sessionStorage.setItem("findback.authReturnTo", JSON.stringify({ route: "/chats/c1", expiresAt: Date.now() - 1 }));
  expect(getAuthReturnRoute()).toBe("/");
  rememberAuthReturnTo("/chats/c2");
  expect(getAuthReturnRoute()).toBe("/chats/c2");
  expect(getAuthReturnRoute()).toBe("/chats/c2");
});
