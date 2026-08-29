import { icon } from "./icons.js";

export const THEME_STORAGE_KEY = "zwap.theme";

export type Theme = "light" | "dark";

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // A profile with site data blocked still gets a themed page; it just
    // cannot remember the choice across reloads.
    return null;
  }
}

function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Same reasoning as `storedTheme`: never let storage break the toggle.
  }
}

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function currentTheme(root: HTMLElement): Theme {
  return root.classList.contains("dark") ? "dark" : "light";
}

function setTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle("dark", theme === "dark");
}

/**
 * Dark is the wallet's native habitat, so the system preference wins until the
 * user says otherwise; an explicit choice then outranks it forever.
 */
export function applyTheme(root: HTMLElement): void {
  setTheme(root, storedTheme() ?? systemTheme());
}

export function toggleTheme(root: HTMLElement): Theme {
  const next: Theme = currentTheme(root) === "dark" ? "light" : "dark";
  setTheme(root, next);
  persistTheme(next);
  return next;
}

/** Wires the masthead switch. The label names the theme the click will apply. */
export function mountThemeToggle(button: HTMLButtonElement, root: HTMLElement): void {
  const paint = (): void => {
    const theme = currentTheme(root);
    button.replaceChildren(icon(theme === "dark" ? "sun" : "moon"));
    button.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"
    );
    button.title = button.getAttribute("aria-label") ?? "";
  };
  button.addEventListener("click", () => {
    toggleTheme(root);
    paint();
  });
  paint();
}
