// Runs render-blocking in <head>, before the module graph and before the first
// paint. Two jobs that must happen that early:
//
//   1. Force HTTPS. A plaintext visit must never reach the wallet code.
//   2. Stamp the theme class, so a dark-mode profile does not flash the light
//      palette while the module bundle loads. `src/ui/theme.ts` owns the
//      runtime toggle and reads the same key with the same precedence.
//
// It is a same-origin file rather than an inline block because the CSP grants
// `script-src 'self'` and no `'unsafe-inline'`.
(function () {
  if (
    window.location.protocol === "http:" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    window.location.replace(
      "https://" +
        window.location.host +
        window.location.pathname +
        window.location.search +
        window.location.hash
    );
    return;
  }

  var stored = null;
  try {
    stored = window.localStorage.getItem("zwap.theme");
  } catch (error) {
    // Site data blocked: fall through to the system preference.
  }
  var theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  document.documentElement.classList.toggle("dark", theme === "dark");
})();
