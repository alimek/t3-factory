// Applies this browser profile's appearance before the stylesheet paints. It is a classic
// blocking script because the deferred app module could run after the first paint; the key
// and values belong to src/appearance.ts. The desktop app serves the page in its own mode.
(function () {
  if (window.factoryDesktop) return;
  let stored = null;
  try {
    stored = window.localStorage.getItem("factory.appearance");
  } catch {
    // Storage can be unavailable (blocked by the profile); the shipped Dark applies.
  }
  if (stored === "light") document.documentElement.dataset.appearance = "light";
})();
