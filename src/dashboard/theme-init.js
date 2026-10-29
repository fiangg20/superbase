"use strict";

// Runs before the first paint, so a saved theme never flashes the wrong colors.
// Browser storage can be blocked, so the read is wrapped.
(function () {
  try {
    var saved = window.localStorage.getItem("superbase-theme");
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  } catch (error) { /* ignore */ }
})();
