// Same-origin so `script-src 'self'` holds: an inline block would be a CSP
// violation on every page load. Runs before the module graph so a plaintext
// visit never reaches the wallet code.
if (
  window.location.protocol === "http:" &&
  window.location.hostname !== "localhost" &&
  window.location.hostname !== "127.0.0.1"
) {
  window.location.replace(
    `https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
  );
}
