(() => {
  const storageKey = "lz-stagescope-watchlist-theme:v1";
  let theme = "dark";
  try {
    theme = window.localStorage.getItem(storageKey) === "light" ? "light" : "dark";
  } catch {
    theme = "dark";
  }
  document.documentElement.dataset.watchlistTheme = theme;
  window.LZWatchlistTheme = {
    set(value) {
      try {
        window.localStorage.setItem(storageKey, value === "light" ? "light" : "dark");
      } catch {
        // Keep the active page theme when storage is unavailable.
      }
    },
  };
})();
