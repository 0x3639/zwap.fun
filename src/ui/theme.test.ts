import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY, applyTheme, currentTheme, toggleTheme } from "./theme.js";

function stubPrefersDark(dark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }));
}

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the system preference when nothing is stored", () => {
    stubPrefersDark(true);
    const root = document.createElement("html");

    applyTheme(root);

    expect(root.classList.contains("dark")).toBe(true);
    expect(currentTheme(root)).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("prefers a stored explicit choice over the system preference", () => {
    stubPrefersDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const root = document.createElement("html");

    applyTheme(root);

    expect(root.classList.contains("dark")).toBe(false);
  });

  it("persists the explicit choice when toggled", () => {
    stubPrefersDark(false);
    const root = document.createElement("html");
    applyTheme(root);

    expect(toggleTheme(root)).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    expect(toggleTheme(root)).toBe("light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("still renders when storage throws", () => {
    stubPrefersDark(true);
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const root = document.createElement("html");

    expect(() => applyTheme(root)).not.toThrow();
    expect(root.classList.contains("dark")).toBe(true);

    getItem.mockRestore();
  });
});
