(() => {
  const storageKey = "lz-trendscope-watchlist-theme:v1";
  const legacyStorageKey = "lz-stagescope-watchlist-theme:v1";
  let theme = "dark";
  try {
    const storedTheme = window.localStorage.getItem(storageKey)
      ?? window.localStorage.getItem(legacyStorageKey);
    theme = storedTheme === "light" ? "light" : "dark";
    window.localStorage.setItem(storageKey, theme);
    window.localStorage.removeItem(legacyStorageKey);
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
