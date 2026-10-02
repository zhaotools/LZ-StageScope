import {
  MEMBER_CONFIG,
  addMemberAsset,
  isDcaEnabled,
  isProfileActive,
  loadMemberAssetResource,
  loadMemberAssetSummaries,
  loadMemberAssets,
  loadMemberInitializationJobs,
  memberErrorMessage,
  removeMemberAsset,
  reorderMemberAssets,
  resolveMemberAssets,
  restoreMemberSession,
  signInMember,
  signOutMember,
  updateMemberDisplayName,
  updateMemberPassword,
  validateMemberDeviceSession,
} from "./member-auth.js?v=1.1.4";

const SITE_ROOT = new URL("./", import.meta.url);
const SITE_BASE_PATH = SITE_ROOT.pathname.replace(/\/$/, "");
const routes = new Set(["overview", "weekly", "daily", "dca", "fundamentals", "methodology"]);
const mobileLayout = window.matchMedia("(max-width: 760px)");
const standaloneLayout = window.matchMedia("(display-mode: standalone)");
const assets = {
  gold: {
    id: "gold",
    code: "GOLD",
    name: "黄金",
    shortName: "黄金",
    eyebrow: "GOLD · DAILY OBSERVATORY",
    memberOnly: true,
  },
  btc: {
    id: "btc",
    code: "BTC",
    name: "比特币",
    shortName: "比特币",
    eyebrow: "BTC · DIGITAL ASSET OBSERVATORY",
    memberOnly: true,
  },
};
const state = {
  assetId: null,
  current: null,
  daily: null,
  weekly: null,
  dca: null,
  fundamentals: null,
  news: null,
  charts: new Map(),
  routeLoads: new Map(),
  loadToken: 0,
  authReady: false,
  memberProfile: null,
  memberAssets: [],
  assetSummaries: new Map(),
  memberJobs: [],
  assetSearchResults: [],
  assetSearchBusy: false,
  assetPollTimer: null,
  watchlistSorting: false,
  watchlistCategory: "all",
  watchlistOrderBeforeEdit: [],
  watchlistOrderSaving: false,
  watchlistView: false,
  watchlistScrollY: 0,
  pendingAssetId: null,
  pendingRoute: "overview",
  pendingDcaNotice: false,
  dcaRangeYears: 1,
};
let chartLibraryPromise;
let memberCaptchaToken = "";
let turnstileWidgetId = null;
let accountCaptchaToken = "";
let accountTurnstileWidgetId = null;
let watchlistDrag = null;
let memberSessionEnding = false;

const ASSET_CODE_PATTERNS = {
  us_equity: /^[A-Z][A-Z0-9.-]{0,14}$/,
  cn_equity: /^\d{6}(?:\.(?:SS|SZ|BJ))?$/,
  hk_equity: /^\d{4,5}(?:\.HK)?$/,
  crypto: /^[A-Z0-9]{2,20}(?:[-/](?:USD|USDT|USDC))?$/,
  commodity: /^[A-Z]{1,12}(?:=F)?$/,
  macro: /^(?:US10Y|DXY)$/,
};
const WATCHLIST_CATEGORIES = new Set(["all", "us_equity", "cn_equity", "hk_equity", "crypto", "commodity", "macro"]);
function applyWatchlistTheme(value, { persist = false } = {}) {
  const theme = value === "light" ? "light" : "dark";
  const targetTheme = theme === "dark" ? "light" : "dark";
  const targetLabel = targetTheme === "light" ? "浅色" : "深色";
  document.documentElement.dataset.watchlistTheme = theme;
  $$("[data-watchlist-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", String(theme === "light"));
    button.setAttribute("aria-label", `切换到${targetLabel}资产列表`);
    button.title = `切换到${targetLabel}资产列表`;
    const label = button.querySelector("[data-watchlist-theme-label]");
    if (label) label.textContent = targetLabel;
  });
  if (!persist) return;
  window.LZWatchlistTheme?.set(theme);
}

function toggleWatchlistTheme() {
  const current = document.documentElement.dataset.watchlistTheme === "light" ? "light" : "dark";
  applyWatchlistTheme(current === "light" ? "dark" : "light", { persist: true });
}

function isAssetCodeQuery(category, value) {
  return Boolean(ASSET_CODE_PATTERNS[category]?.test(String(value || "").trim().toUpperCase()));
}

function dismissAppSplash() {
  const splash = document.getElementById("app-splash");
  if (!splash) return;
  const delay = Math.max(0, 700 - performance.now());
  window.setTimeout(() => {
    splash.classList.add("is-ready");
    document.body.classList.remove("app-booting");
    document.body.setAttribute("aria-busy", "false");
    window.setTimeout(() => splash.remove(), 420);
  }, delay);
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[char]));
const fmt = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const fmtDate = (value) => value ? String(value).slice(0, 10) : "—";
const shiftIsoMonths = (value, months) => {
  const date = new Date(`${fmtDate(value)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};
const impactLabel = { support: "支持", pressure: "压力", neutral: "中性", unavailable: "待接入" };
const directionLabel = { up: "上升", down: "下降", flat: "持平", unknown: "暂无数据" };
const stagePresentation = {
  1: { code: "S1", title: "低位整理", phase: "底部阶段", arrow: "◆", color: "#4b82c3" },
  2: { code: "S2", title: "上升趋势", phase: "上升阶段", arrow: "▲", color: "#16835d" },
  3: { code: "S3", title: "高位整理", phase: "顶部阶段", arrow: "◆", color: "#c98632" },
  4: { code: "S4", title: "下降趋势", phase: "下降阶段", arrow: "▼", color: "#c94f55" },
};
const knownChineseAssetNames = {
  "600519.SS": "贵州茅台",
  "300285.SZ": "国瓷材料",
  "399006.SZ": "创业板指",
  "000001.SS": "上证指数",
  "000300.SS": "沪深300",
  "0700.HK": "腾讯控股",
  "1810.HK": "小米集团-W",
  "9988.HK": "阿里巴巴-W",
};

function localizedMarketName(category, code, symbol, ...candidates) {
  if (!["cn_equity", "hk_equity"].includes(category)) {
    return candidates.find((value) => String(value || "").trim()) || code;
  }
  const normalizedSymbol = String(symbol || "").toUpperCase();
  if (knownChineseAssetNames[normalizedSymbol]) return knownChineseAssetNames[normalizedSymbol];
  const localized = candidates.find((value) => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(value || "")));
  return localized || `${category === "cn_equity" ? "A股" : "港股"} ${code}`;
}

function displayAssetCode(assetId, candidate) {
  return assetId === "gold" ? "GOLD" : candidate;
}

function updateAssetPresentationFromSnapshot(assetId, snapshot) {
  const presentation = assets[assetId];
  const item = snapshot?.asset;
  if (!presentation || !item) return;
  const category = item.categoryId || presentation.category;
  const name = localizedMarketName(
    category,
    presentation.code,
    item.symbol,
    item.name,
    presentation.name,
  );
  presentation.name = name;
  presentation.shortName = name;
  presentation.category = category;
  presentation.code = displayAssetCode(assetId, item.displaySymbol || presentation.code);
  presentation.currency = item.currency || presentation.currency;
}

function loadAssetResource(assetId, resource) {
  if (resource === "dca-series.json") {
    if (!canUseDca(assetId)) throw new Error(isMacroAsset(assetId) ? "宏观资产不提供定投建议。" : "当前账号未开通定投指标。");
    return loadMemberAssetResource(assetId, resource);
  }
  return loadMemberAssetResource(assetId, resource);
}

function routePath(route, assetId = state.assetId) {
  if (!assetId) return watchlistPath();
  return `${SITE_BASE_PATH}/${assetId}/${route}`;
}

function watchlistPath() {
  return `${SITE_BASE_PATH}/watchlist`;
}

function isMember() {
  return isProfileActive(state.memberProfile);
}

function canUseDca(assetId = state.assetId) {
  return !isMacroAsset(assetId) && isDcaEnabled(state.memberProfile);
}

function isMacroAsset(assetId = state.assetId) {
  return assets[assetId]?.category === "macro";
}

function isLegacyMacroObservation(assetId = state.assetId) {
  const snapshot = assetId === state.assetId ? state.current : state.assetSummaries.get(assetId);
  return snapshot?.schemaVersion === "macro-observation-v1";
}

function canAccessAsset(assetId) {
  const row = memberAssetRow(assetId);
  return Boolean(isMember() && assets[assetId] && row?.status === "ready");
}

function firstAccessibleAssetId() {
  return readWatchlist().find((assetId) => canAccessAsset(assetId)) || null;
}

function locationContext() {
  const forwardedPath = new URLSearchParams(location.search).get("route");
  const candidatePath = forwardedPath || location.pathname.slice(SITE_BASE_PATH.length);
  const parts = candidatePath.split("/").filter(Boolean);
  const watchlist = parts[0] === "watchlist";
  const assetId = assets[parts[0]] ? parts[0] : null;
  const pathRoute = parts[1];
  const legacyRoute = location.hash.split("/").filter(Boolean).at(-1);
  const route = pathRoute || legacyRoute || "overview";
  return { assetId, route: routes.has(route) ? route : "overview", view: watchlist ? "watchlist" : "asset" };
}

function routeFromLocation() {
  return locationContext().route;
}

function isStandaloneApp() {
  return standaloneLayout.matches || window.navigator.standalone === true;
}

function isRootEntry() {
  const rootPath = location.pathname === SITE_ROOT.pathname || location.pathname === SITE_BASE_PATH;
  const forwardedRoute = new URLSearchParams(location.search).has("route");
  return rootPath && !forwardedRoute && !location.hash;
}

function normalizeRoute({ preferFirstAsset = false, preferWatchlist = false } = {}) {
  const context = locationContext();
  let { assetId, route, view } = context;
  const firstAssetId = firstAccessibleAssetId();
  if (!firstAssetId) {
    state.loadToken += 1;
    state.assetId = null;
    document.body.classList.remove("macro-asset", "macro-observation");
    state.current = null;
    state.daily = null;
    state.weekly = null;
    state.dca = null;
    state.fundamentals = null;
    state.news = null;
    state.routeLoads.clear();
    clearCharts();
    state.watchlistView = mobileLayout.matches;
    const target = watchlistPath();
    if (location.pathname !== target || location.search || location.hash) {
      history.replaceState({ view: "watchlist" }, "", target);
    }
    syncPageMode();
    updateRouteLinks();
    return null;
  }
  if (mobileLayout.matches && (preferWatchlist || (view === "watchlist" && !preferFirstAsset))) {
    state.assetId = canAccessAsset(state.assetId) ? state.assetId : firstAssetId;
    state.watchlistView = true;
    const target = watchlistPath();
    if (location.pathname !== target || location.search || location.hash) {
      history.replaceState({ view: "watchlist", assetId: state.assetId }, "", target);
    }
    syncPageMode();
    updateRouteLinks();
    return "overview";
  }
  if (view === "watchlist") {
    assetId = canAccessAsset(state.assetId) ? state.assetId : firstAssetId;
    route = "overview";
    view = "asset";
  }
  if (!canAccessAsset(assetId)) {
    assetId = firstAssetId;
    route = route === "methodology" ? route : "overview";
  }
  if (isLegacyMacroObservation(assetId) && !["overview", "methodology"].includes(route)) route = "overview";
  if (isMacroAsset(assetId) && route === "dca") route = "overview";
  if (route === "dca" && !canUseDca(assetId)) {
    if (isMember()) {
      state.pendingDcaNotice = true;
    } else {
      state.pendingAssetId = assetId;
      state.pendingRoute = "dca";
    }
    route = "overview";
  }
  state.watchlistView = false;
  state.assetId = assetId;
  const target = routePath(route, assetId);
  if (location.pathname !== target || location.search || location.hash) {
    history.replaceState({ assetId, route }, "", target);
  }
  syncPageMode();
  syncRouteShell(route);
  updateRouteLinks();
  return route;
}

function updateRouteLinks() {
  $$('[data-route]').forEach((link) => {
    link.href = routePath(link.dataset.route);
    if (["weekly", "daily", "dca", "fundamentals"].includes(link.dataset.route)) {
      link.hidden = isLegacyMacroObservation() || (link.dataset.route === "dca" && !canUseDca());
    }
  });
  $$('[data-watchlist-link]').forEach((link) => { link.href = watchlistPath(); });
}

function lockMobilePageZoom() {
  if (!navigator.maxTouchPoints) return;
  const preventZoom = (event) => event.preventDefault();
  ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
    document.addEventListener(eventName, preventZoom, { passive: false });
  });
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length > 1) preventZoom(event);
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) preventZoom(event);
    lastTouchEnd = now;
  }, { passive: false });
}

function memberAssetRow(assetId) {
  return state.memberAssets.find((row) => row.asset?.asset_id === assetId) || null;
}

function readWatchlist() {
  if (!isMember()) return [];
  const ids = state.memberAssets.map((row) => row.asset?.asset_id).filter(Boolean);
  return [...new Set(ids)];
}

function registerMemberAssets(rows) {
  state.memberAssets = Array.isArray(rows) ? rows : [];
  for (const row of state.memberAssets) {
    const item = row.asset;
    if (!item?.asset_id) continue;
    const code = displayAssetCode(item.asset_id, item.display_symbol || item.provider_symbol);
    const name = localizedMarketName(item.category, code, item.provider_symbol, item.name);
    assets[item.asset_id] = {
      id: item.asset_id,
      code,
      name,
      shortName: name,
      eyebrow: `${code} · ${String(item.category || "ASSET").replaceAll("_", " ").toUpperCase()} OBSERVATORY`,
      memberOnly: true,
      category: item.category,
      currency: item.currency,
      exchange: item.exchange,
      status: row.status,
    };
  }
}

function applyMemberAssetOrder(assetIds) {
  const position = new Map(assetIds.map((assetId, index) => [assetId, index]));
  state.memberAssets = [...state.memberAssets].sort((left, right) => {
    const leftId = left?.asset?.asset_id;
    const rightId = right?.asset?.asset_id;
    const leftPosition = position.has(leftId) ? position.get(leftId) : assetIds.length + Number(left?.position || 0);
    const rightPosition = position.has(rightId) ? position.get(rightId) : assetIds.length + Number(right?.position || 0);
    return leftPosition - rightPosition;
  });
}

function registerMemberSummaries(rows) {
  const summaries = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.asset_id && row?.payload) {
      summaries.set(row.asset_id, row.payload);
      updateAssetPresentationFromSnapshot(row.asset_id, row.payload);
    }
  }
  // A published current snapshot is the strongest readiness signal. This also
  // repairs a stale in-memory `initializing` row when iOS suspended polling
  // while the background initialization job completed.
  for (const memberRow of state.memberAssets) {
    const assetId = memberRow?.asset?.asset_id;
    if (!assetId || !summaries.has(assetId)) continue;
    memberRow.status = "ready";
    if (memberRow.asset) memberRow.asset.status = "ready";
    if (assets[assetId]) assets[assetId].status = "ready";
  }
  state.assetSummaries = summaries;
}

function watchlistSnapshot(assetId) {
  if (assetId === state.assetId && state.current) return state.current;
  return state.assetSummaries.get(assetId) || null;
}

function watchlistQuote(snapshot) {
  const price = Number(snapshot?.quote?.price);
  const previousClose = Number(snapshot?.quote?.previousClose);
  const validPrice = Number.isFinite(price);
  const validPrevious = Number.isFinite(previousClose) && previousClose !== 0;
  const change = validPrice && validPrevious ? ((price - previousClose) / previousClose) * 100 : null;
  const freshness = snapshot?.quality?.marketFreshness;
  const macro = snapshot?.asset?.categoryId === "macro";
  const yieldSeries = macro && snapshot?.macro?.code === "US10Y";
  return {
    price: validPrice
      ? `${price.toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}${yieldSeries ? "%" : ""}`
      : "—",
    change: yieldSeries && validPrice && validPrevious
      ? `${(price - previousClose) >= 0 ? "+" : ""}${((price - previousClose) * 100).toFixed(1)}bp`
      : Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—",
    tone: macro ? "" : Number.isFinite(change) ? (change >= 0 ? "positive" : "negative") : "",
    delayed: freshness?.sourceFresh === false,
    date: freshness?.lastDate || snapshot?.quote?.date || "",
  };
}

function watchlistWeekly(snapshot, fallbackStatus) {
  if (snapshot?.schemaVersion === "macro-observation-v1") return "待更新";
  const confirmed = snapshot?.weekly?.current?.confirmed;
  const code = confirmed?.label || confirmed?.code;
  const weeks = Number(confirmed?.weeks);
  if (code) return `${code}${Number.isFinite(weeks) ? ` · ${weeks}周` : ""}`;
  return fallbackStatus === "initializing" ? "初始化中" : fallbackStatus === "failed" ? "失败" : "—";
}

function assetStatusLabel(status) {
  return ({ ready: "数据就绪", initializing: "正在初始化", failed: "初始化失败" })[status] || "等待处理";
}

function instrumentTypeLabel(value) {
  return ({ EQUITY: "个股", ETF: "ETF", INDEX: "指数", MACRO: "宏观观察项" })[String(value || "").toUpperCase()] || "资产";
}

function catalogMarketSource(asset) {
  if (asset.category === "macro") return asset.displaySymbol === "US10Y" ? "Yahoo Finance / Cboe 10年期收益率" : "Yahoo Finance / ICE 美元指数";
  if (asset.category === "cn_equity" && String(asset.quoteType || "").toUpperCase() === "INDEX") {
    return "腾讯证券";
  }
  if (asset.category !== "crypto") return "Yahoo Finance";
  return String(asset.providerSymbol || "").toUpperCase() === "HYPE-USD"
    ? "Hyperliquid 现货"
    : "Binance 现货";
}

function renderAssetSearchResults() {
  const catalog = $("#asset-catalog");
  if (!isMember()) {
    catalog.innerHTML = '<p class="catalog-empty">登录会员账号后管理自选资产。</p>';
    return;
  }
  const existing = new Set(readWatchlist());
  catalog.innerHTML = state.assetSearchResults.length ? state.assetSearchResults.map((asset, index) => {
    const added = existing.has(asset.assetId);
    return `
      <button class="catalog-asset" type="button" data-add-result="${index}" ${added || state.assetSearchBusy ? "disabled" : ""}>
        <span><strong>${esc(asset.name)}</strong>${esc(asset.providerSymbol)} · ${esc(asset.exchange)}<small>${esc(catalogMarketSource(asset))} · ${esc(instrumentTypeLabel(asset.quoteType))} · 已确认分类</small></span>
        <em>${added ? "已添加" : "添加并初始化"}</em>
      </button>
    `;
  }).join("") : "";
}

function renderWatchlist() {
  const watchlist = readWatchlist();
  const visibleWatchlist = state.watchlistCategory === "all"
    ? watchlist
    : watchlist.filter((assetId) => assets[assetId]?.category === state.watchlistCategory);
  const member = isMember();
  const addButton = $("#add-asset-button");
  const sortButton = $("#watchlist-sort-button");
  const categoryFilter = $("#watchlist-category-filter");
  const watchlistNode = $("#asset-watchlist");
  categoryFilter.value = state.watchlistCategory;
  $(".watchlist-table-header span:nth-child(2)").textContent = state.watchlistCategory === "macro" ? "最新值" : "日收盘";
  categoryFilter.disabled = !watchlist.length || state.watchlistSorting;
  addButton.hidden = !member;
  addButton.disabled = member && (watchlist.length >= 30 || state.watchlistSorting);
  addButton.title = state.watchlistSorting
    ? "请先完成资产排序"
    : watchlist.length >= 30 ? "个人资产已达到 30 个上限" : "新增资产";
  sortButton.hidden = !member;
  sortButton.disabled = state.watchlistOrderSaving
    || (!state.watchlistSorting && (watchlist.length < 2 || state.watchlistCategory !== "all"));
  sortButton.classList.toggle("active", state.watchlistSorting);
  sortButton.setAttribute("aria-pressed", String(state.watchlistSorting));
  sortButton.setAttribute("aria-label", state.watchlistSorting ? "完成资产排序" : "调整资产顺序");
  sortButton.title = state.watchlistSorting
    ? "完成并保存排序"
    : state.watchlistCategory !== "all" ? "请先切换到“自选”后调整顺序" : "调整资产顺序";
  $("#asset-count").textContent = `${watchlist.length} / 30`;
  watchlistNode.classList.toggle("sorting", state.watchlistSorting);
  watchlistNode.setAttribute("aria-label", state.watchlistSorting ? "自选观察列表，排序模式" : "自选观察列表");
  if (!watchlist.length) {
    watchlistNode.innerHTML = '<p class="watchlist-empty">请注册会员，登录系统，添加我的观察列表。</p>';
    renderAssetSearchResults();
    return;
  }
  if (!visibleWatchlist.length) {
    watchlistNode.innerHTML = '<p class="watchlist-empty">当前分类暂无自选资产。</p>';
    renderAssetSearchResults();
    return;
  }
  watchlistNode.innerHTML = visibleWatchlist.map((assetId) => {
    const asset = assets[assetId];
    if (!asset) return "";
    const row = memberAssetRow(assetId);
    const status = row?.status || asset.status || "initializing";
    const ready = status === "ready";
    const removable = member;
    const snapshot = ready ? watchlistSnapshot(assetId) : null;
    const quote = watchlistQuote(snapshot);
    const weekly = watchlistWeekly(snapshot, status);
    const weeklyStage = weekly.match(/^S([1-4])/i)?.[1] || "";
    return `
      <button class="watchlist-asset ${assetId === state.assetId ? "active" : ""} ${esc(status)}" type="button" data-asset="${esc(assetId)}" data-status="${esc(status)}" aria-pressed="${assetId === state.assetId}" ${state.watchlistSorting ? 'aria-grabbed="false"' : ""} aria-label="${esc(asset.shortName)}${state.watchlistSorting ? "，可拖动排序" : ""}">
        ${state.watchlistSorting ? '<span class="watchlist-drag-handle" role="button" tabindex="0" aria-label="按住拖动资产排序" aria-grabbed="false" title="按住拖动排序"><span aria-hidden="true">⋮</span></span>' : ""}
        <span class="watchlist-asset-copy"><strong>${esc(asset.code)}${asset.category === "macro" ? "" : `/${esc(asset.currency || "USD")}`}</strong><small>${esc(asset.shortName)}</small></span>
        <span class="watchlist-price ${quote.delayed ? "delayed" : ""}" ${quote.delayed ? `title="${esc(`${asset.category === "macro" ? "数据" : "行情"}延迟，最近可用 ${fmtDate(quote.date)}`)}"` : ""}>${ready ? quote.price : "—"}</span>
        <span class="watchlist-change ${quote.tone}">${ready ? quote.change : "—"}</span>
        <span class="watchlist-stage ${weeklyStage ? `stage-s${weeklyStage}` : ""}">${weekly}</span>
        ${removable ? `<span class="watchlist-remove" role="button" tabindex="0" data-remove-asset="${esc(assetId)}" aria-label="从自选移除">×</span>` : ""}
      </button>
    `;
  }).join("");
  renderAssetSearchResults();
}

function watchlistDomOrder() {
  return $$(".watchlist-asset[data-asset]", $("#asset-watchlist")).map((node) => node.dataset.asset);
}

function syncWatchlistOrderFromDom() {
  applyMemberAssetOrder(watchlistDomOrder());
}

function moveWatchlistAsset(source, target, placeAfter) {
  if (!source || !target || source === target) return;
  const list = $("#asset-watchlist");
  list.insertBefore(source, placeAfter ? target.nextElementSibling : target);
  syncWatchlistOrderFromDom();
}

function finishWatchlistDrag() {
  if (!watchlistDrag) return;
  watchlistDrag.source.classList.remove("dragging");
  watchlistDrag.source.setAttribute("aria-grabbed", "false");
  watchlistDrag.handle.setAttribute("aria-grabbed", "false");
  document.body.classList.remove("watchlist-dragging");
  watchlistDrag = null;
}

function handleWatchlistPointerDown(event) {
  if (!state.watchlistSorting || state.watchlistOrderSaving) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const handle = event.target.closest(".watchlist-drag-handle");
  if (!handle) return;
  const source = handle.closest(".watchlist-asset[data-asset]");
  if (!source) return;
  event.preventDefault();
  handle.setPointerCapture?.(event.pointerId);
  source.classList.add("dragging");
  source.setAttribute("aria-grabbed", "true");
  handle.setAttribute("aria-grabbed", "true");
  document.body.classList.add("watchlist-dragging");
  watchlistDrag = { source, handle, pointerId: event.pointerId };
}

function handleWatchlistPointerMove(event) {
  if (!watchlistDrag || watchlistDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const list = $("#asset-watchlist");
  const horizontal = mobileLayout.matches && !state.watchlistView;
  const scrollNode = horizontal ? list : state.watchlistView ? document.scrollingElement : $(".asset-sidebar");
  const scrollRect = state.watchlistView
    ? { top: 0, bottom: window.innerHeight }
    : scrollNode.getBoundingClientRect();
  if (horizontal) {
    if (event.clientX < scrollRect.left + 42) list.scrollLeft -= 14;
    if (event.clientX > scrollRect.right - 42) list.scrollLeft += 14;
  } else {
    if (event.clientY < scrollRect.top + 48) scrollNode.scrollTop -= 14;
    if (event.clientY > scrollRect.bottom - 48) scrollNode.scrollTop += 14;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".watchlist-asset[data-asset]");
  if (!target || target.parentElement !== list || target === watchlistDrag.source) return;
  const rect = target.getBoundingClientRect();
  const placeAfter = horizontal
    ? event.clientX > rect.left + rect.width / 2
    : event.clientY > rect.top + rect.height / 2;
  moveWatchlistAsset(watchlistDrag.source, target, placeAfter);
}

function handleWatchlistPointerUp(event) {
  if (!watchlistDrag || watchlistDrag.pointerId !== event.pointerId) return;
  finishWatchlistDrag();
}

function handleWatchlistKeydown(event) {
  if (!state.watchlistSorting || state.watchlistOrderSaving) return;
  const handle = event.target.closest(".watchlist-drag-handle");
  if (!handle) return;
  const source = handle.closest(".watchlist-asset[data-asset]");
  if (!source) return;
  const backward = ["ArrowUp", "ArrowLeft"].includes(event.key);
  const forward = ["ArrowDown", "ArrowRight"].includes(event.key);
  if (!backward && !forward) return;
  const target = backward ? source.previousElementSibling : source.nextElementSibling;
  if (!target) return;
  event.preventDefault();
  moveWatchlistAsset(source, target, forward);
  handle.focus();
}

async function toggleWatchlistSorting() {
  if (!isMember() || state.watchlistOrderSaving || state.watchlistCategory !== "all") return;
  if (!state.watchlistSorting) {
    state.watchlistOrderBeforeEdit = readWatchlist();
    state.watchlistSorting = true;
    renderWatchlist();
    $(".watchlist-drag-handle")?.focus();
    return;
  }
  finishWatchlistDrag();
  const nextOrder = watchlistDomOrder();
  const memberOrder = nextOrder.filter((assetId) => memberAssetRow(assetId));
  state.watchlistOrderSaving = true;
  renderWatchlist();
  try {
    await reorderMemberAssets(memberOrder);
    applyMemberAssetOrder(nextOrder);
    state.watchlistSorting = false;
    state.watchlistOrderBeforeEdit = [];
  } catch (error) {
    applyMemberAssetOrder(state.watchlistOrderBeforeEdit);
    state.watchlistSorting = false;
    window.alert(`资产排序保存失败：${memberErrorMessage(error)}`);
  } finally {
    state.watchlistOrderSaving = false;
    renderWatchlist();
  }
}

function setAssetPickerMessage(message, tone = "") {
  const node = $("#asset-picker-message");
  node.textContent = message;
  node.className = `asset-picker-message${tone ? ` ${tone}` : ""}`;
}

function initializationStageLabel(stage) {
  return ({
    queued: "已加入初始化队列",
    fetching_history: "正在获取历史行情",
    publishing: "正在发布数据快照",
    complete: "初始化完成",
    failed: "初始化失败",
  })[stage] || "正在执行初始化";
}

function initializationFailureMessage(job) {
  return ({
    market_history_failed: "历史行情暂时无法获取，请稍后移除并重新添加。",
    macro_history_failed: "宏观数据源暂时无法获取，请稍后移除并重新添加。",
    daily_analysis_failed: "日线状态分析未完成，请稍后重试。",
    weekly_analysis_failed: "周线阶段分析未完成，请稍后重试。",
    fundamentals_build_failed: "基本面初始状态生成未完成，请稍后重试。",
    news_build_failed: "最近重要动态生成未完成，请稍后重试。",
    snapshot_build_failed: "分析快照生成未完成，请稍后重试。",
    snapshot_validation_failed: "分析快照校验未通过，请稍后重试。",
    snapshot_publish_failed: "分析快照发布未完成，请稍后重试。",
  })[job?.error_code] || "初始化未完成，请稍后移除并重新添加。";
}

async function refreshMemberLibrary({ quiet = false } = {}) {
  if (!isMember()) {
    registerMemberAssets([]);
    registerMemberSummaries([]);
    state.memberJobs = [];
    renderWatchlist();
    return;
  }
  try {
    const draftOrder = state.watchlistSorting ? watchlistDomOrder() : [];
    const [rows, jobs, summaries] = await Promise.all([
      loadMemberAssets(),
      loadMemberInitializationJobs(),
      loadMemberAssetSummaries(),
    ]);
    registerMemberAssets(rows);
    if (draftOrder.length) applyMemberAssetOrder(draftOrder);
    registerMemberSummaries(summaries);
    state.memberJobs = jobs;
    renderWatchlist();
    const activeJobs = jobs.filter((job) => ["queued", "running"].includes(job.status));
    const pendingAssets = state.memberAssets.filter((row) => row.status === "initializing");
    if (activeJobs.length && !quiet) {
      const latest = activeJobs[0];
      setAssetPickerMessage(`${initializationStageLabel(latest.progress_stage)}，完成后会自动出现在自选中。`);
    }
    scheduleMemberAssetPoll(activeJobs.length > 0 || pendingAssets.length > 0);
  } catch (error) {
    if (!quiet) setAssetPickerMessage("暂时无法读取会员自选，请稍后重试。", "error");
    console.error(error);
  }
}

let lastMemberResumeRefresh = 0;

function isEndedMemberSession(error) {
  return ["session_expired", "session_replaced", "http_401"].includes(String(error?.code || ""));
}

async function handleEndedMemberSession(error) {
  if (memberSessionEnding || !isMember()) return;
  memberSessionEnding = true;
  try {
    await resetMemberUiAfterSessionEnd();
    window.alert(memberErrorMessage(error));
  } finally {
    memberSessionEnding = false;
  }
}

async function validateActiveMemberSession({ refreshLibrary = false } = {}) {
  if (!isMember() || document.visibilityState === "hidden" || memberSessionEnding) return;
  try {
    await validateMemberDeviceSession();
    if (refreshLibrary) await refreshMemberLibrary({ quiet: true });
  } catch (error) {
    if (isEndedMemberSession(error)) {
      await handleEndedMemberSession(error);
      return;
    }
    console.warn("Unable to validate the member device session", error);
  }
}

function refreshMemberLibraryOnResume() {
  if (!isMember() || document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastMemberResumeRefresh < 1500) return;
  lastMemberResumeRefresh = now;
  void validateActiveMemberSession({ refreshLibrary: true });
}

function heartbeatMemberDeviceSession() {
  void validateActiveMemberSession();
}

function scheduleMemberAssetPoll(active) {
  if (state.assetPollTimer) window.clearTimeout(state.assetPollTimer);
  state.assetPollTimer = active && isMember()
    ? window.setTimeout(async () => {
      const before = new Map(state.memberAssets.map((row) => [row.asset?.asset_id, row.status]));
      await refreshMemberLibrary({ quiet: true });
      const completed = state.memberAssets.find((row) => before.get(row.asset?.asset_id) === "initializing" && row.status === "ready");
      if (completed) setAssetPickerMessage(`${completed.asset.name}初始化完成，已可以打开。`, "success");
    }, 7000)
    : null;
}

async function handleAssetSearch(event) {
  event.preventDefault();
  const category = $("#asset-category").value;
  const query = $("#asset-query").value.trim().toUpperCase();
  if (!category) {
    setAssetPickerMessage("请先选择资产分类。", "error");
    $("#asset-category").focus();
    return;
  }
  if (!query) {
    setAssetPickerMessage("请输入资产代码。", "error");
    $("#asset-query").focus();
    return;
  }
  if (!isAssetCodeQuery(category, query)) {
    setAssetPickerMessage("仅支持按资产代码查询，请检查代码格式。", "error");
    $("#asset-query").focus();
    return;
  }
  $("#asset-query").value = query;
  state.assetSearchBusy = true;
  state.assetSearchResults = [];
  $("#asset-search-submit").disabled = true;
  $("#asset-search-submit").textContent = "查询中…";
  setAssetPickerMessage("正在查询对应数据源并核对资产分类…");
  renderAssetSearchResults();
  try {
    const result = await resolveMemberAssets(category, query);
    state.assetSearchResults = result.assets || [];
    setAssetPickerMessage(
      state.assetSearchResults.length ? `找到 ${state.assetSearchResults.length} 个可核验资产，请选择。` : "数据源中没有找到符合该分类的资产。",
      state.assetSearchResults.length ? "success" : "error",
    );
  } catch (error) {
    setAssetPickerMessage(memberErrorMessage(error), "error");
  } finally {
    state.assetSearchBusy = false;
    $("#asset-search-submit").disabled = false;
    $("#asset-search-submit").textContent = "查询";
    renderAssetSearchResults();
  }
}

async function handleAddAsset(index) {
  if (readWatchlist().length >= 30) {
    setAssetPickerMessage("个人资产已达到 30 个上限，请先移除一个资产。", "error");
    return;
  }
  const candidate = state.assetSearchResults[index];
  if (!candidate || state.assetSearchBusy) return;
  state.assetSearchBusy = true;
  renderAssetSearchResults();
  setAssetPickerMessage(`正在确认 ${candidate.name} 的历史数据并创建初始化任务…`);
  try {
    const result = await addMemberAsset(candidate);
    await refreshMemberLibrary({ quiet: true });
    if (result.memberStatus === "ready") {
      setAssetPickerMessage(`${candidate.name}已有可用数据，已加入自选。`, "success");
    } else {
      setAssetPickerMessage(`${candidate.name}已加入初始化队列，通常需要数分钟。关闭窗口不会中断任务。`, "success");
      scheduleMemberAssetPoll(true);
    }
  } catch (error) {
    setAssetPickerMessage(memberErrorMessage(error), "error");
  } finally {
    state.assetSearchBusy = false;
    renderAssetSearchResults();
  }
}

async function handleRemoveAsset(assetId) {
  const asset = assets[assetId];
  if (!asset) return;
  if (!window.confirm(`从“我的自选”移除${asset.name}？共享行情数据不会被删除。`)) return;
  try {
    await removeMemberAsset(assetId);
    await refreshMemberLibrary({ quiet: true });
    if (state.assetId === assetId) {
      const nextAssetId = firstAccessibleAssetId();
      if (nextAssetId) {
        await loadAsset(nextAssetId, { historyMode: state.watchlistView ? "none" : "push", targetRoute: "overview" });
      } else {
        normalizeRoute();
        renderWatchlist();
      }
    }
  } catch (error) {
    window.alert(memberErrorMessage(error));
  }
}

function memberExpiryLabel(profile = state.memberProfile) {
  if (!profile) return "访客模式";
  if (profile.role === "admin") return "管理员账号";
  return profile.expires_at ? `有效至 ${fmtDate(profile.expires_at)}` : "会员账号";
}

function renderMemberControls() {
  const active = isMember();
  const loginButton = $("#member-login-button");
  const account = $("#member-account");
  loginButton.hidden = active;
  loginButton.disabled = !state.authReady;
  loginButton.textContent = state.authReady ? "会员登录" : "检查登录…";
  account.hidden = !active;
  $("#member-display-name").textContent = state.memberProfile?.display_name || "会员";
  $("#member-expiry").textContent = memberExpiryLabel();
  $$('[data-member-action] span').forEach((label) => {
    label.textContent = active ? state.memberProfile?.display_name || "账号" : state.authReady ? "登录" : "检查中";
  });
}

function syncMemberSubmit() {
  const email = $("#member-email").value.trim();
  const password = $("#member-password").value;
  const button = $("#member-login-submit");
  if (button.dataset.loading === "true") return;
  const captchaReady = !MEMBER_CONFIG.turnstileSiteKey || Boolean(memberCaptchaToken);
  button.disabled = !email || !password || !captchaReady;
  button.textContent = captchaReady ? "登录并查看" : "完成安全验证后登录";
}

function removeTurnstileWidget() {
  if (turnstileWidgetId !== null && window.turnstile) {
    window.turnstile.remove(turnstileWidgetId);
  }
  turnstileWidgetId = null;
  memberCaptchaToken = "";
  $("#member-turnstile").replaceChildren();
  syncMemberSubmit();
}

function setAccountFeedback(selector, message = "", tone = "") {
  const node = $(selector);
  node.hidden = !message;
  node.textContent = message;
  node.className = `account-feedback${tone ? ` ${tone}` : ""}`;
}

function syncAccountPasswordSubmit() {
  const button = $("#password-submit");
  if (button.dataset.loading === "true") return;
  const currentPassword = $("#account-current-password").value;
  const newPassword = $("#account-new-password").value;
  const confirmPassword = $("#account-confirm-password").value;
  const captchaReady = !MEMBER_CONFIG.turnstileSiteKey || Boolean(accountCaptchaToken);
  button.disabled = !currentPassword || newPassword.length < 8 || newPassword !== confirmPassword || !captchaReady;
}

function removeAccountTurnstileWidget() {
  if (accountTurnstileWidgetId !== null && window.turnstile) {
    window.turnstile.remove(accountTurnstileWidgetId);
  }
  accountTurnstileWidgetId = null;
  accountCaptchaToken = "";
  $("#account-password-turnstile").replaceChildren();
  syncAccountPasswordSubmit();
}

async function renderAccountTurnstileWidget() {
  removeAccountTurnstileWidget();
  if (!MEMBER_CONFIG.turnstileSiteKey) {
    accountCaptchaToken = "not-required";
    $("#account-password-turnstile").hidden = true;
    syncAccountPasswordSubmit();
    return;
  }
  $("#account-password-turnstile").hidden = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ($("#member-dialog").hidden || $("#member-account-view").hidden) return;
    if (window.turnstile) {
      accountTurnstileWidgetId = window.turnstile.render("#account-password-turnstile", {
        sitekey: MEMBER_CONFIG.turnstileSiteKey,
        action: "member-password-update",
        theme: "light",
        language: "zh-CN",
        size: "flexible",
        callback: (token) => { accountCaptchaToken = token; syncAccountPasswordSubmit(); },
        "expired-callback": () => { accountCaptchaToken = ""; syncAccountPasswordSubmit(); },
        "error-callback": () => { accountCaptchaToken = ""; syncAccountPasswordSubmit(); },
      });
      return;
    }
    await wait(100);
  }
  setAccountFeedback("#password-feedback", "安全验证组件未能加载，请检查网络后重试。", "error");
}

async function renderTurnstileWidget() {
  removeTurnstileWidget();
  if (!MEMBER_CONFIG.turnstileSiteKey) {
    memberCaptchaToken = "not-required";
    $("#member-turnstile").hidden = true;
    syncMemberSubmit();
    return;
  }
  $("#member-turnstile").hidden = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ($("#member-dialog").hidden || $("#member-login-view").hidden) return;
    if (window.turnstile) {
      turnstileWidgetId = window.turnstile.render("#member-turnstile", {
        sitekey: MEMBER_CONFIG.turnstileSiteKey,
        action: "member-login",
        theme: "light",
        language: "zh-CN",
        size: "flexible",
        callback: (token) => { memberCaptchaToken = token; syncMemberSubmit(); },
        "expired-callback": () => { memberCaptchaToken = ""; syncMemberSubmit(); },
        "error-callback": () => { memberCaptchaToken = ""; syncMemberSubmit(); },
      });
      return;
    }
    await wait(100);
  }
  $("#member-login-error").hidden = false;
  $("#member-login-error").textContent = "安全验证组件未能加载，请检查网络后重试。";
}

function openMemberLogin(assetId = null, route = "overview") {
  removeAccountTurnstileWidget();
  if (assetId) {
    state.pendingAssetId = assetId;
    state.pendingRoute = routes.has(route) ? route : "overview";
  }
  $("#member-login-view").hidden = false;
  $("#member-account-view").hidden = true;
  $(".member-dialog-panel").classList.remove("member-account-mode");
  $(".member-dialog-panel").setAttribute("aria-labelledby", "member-dialog-title");
  $("#member-dialog-title").textContent = assetId ? "LZ会员专享" : "会员登录";
  $("#member-dialog-copy").textContent = assetId
    ? `登录会员账号后查看${assets[assetId]?.name || "全部资产"}的完整观察数据。`
    : "登录会员账号后查看全部资产。";
  $("#member-login-error").hidden = true;
  $("#member-login-error").textContent = "";
  $("#member-password").value = "";
  $("#member-dialog").hidden = false;
  document.body.classList.add("member-dialog-open");
  $("#member-email").focus();
  void renderTurnstileWidget();
}

function openMemberAccount() {
  if (!isMember()) {
    openMemberLogin();
    return;
  }
  removeTurnstileWidget();
  $("#member-login-view").hidden = true;
  $("#member-account-view").hidden = false;
  $(".member-dialog-panel").classList.add("member-account-mode");
  $(".member-dialog-panel").setAttribute("aria-labelledby", "member-account-title");
  $("#member-dialog-name").textContent = state.memberProfile.display_name || "会员";
  $("#member-dialog-expiry").textContent = memberExpiryLabel();
  $("#account-display-name").value = state.memberProfile.display_name || "";
  $("#account-current-password").value = "";
  $("#account-new-password").value = "";
  $("#account-confirm-password").value = "";
  setAccountFeedback("#display-name-feedback");
  setAccountFeedback("#password-feedback");
  $("#member-dialog").hidden = false;
  document.body.classList.add("member-dialog-open");
  void renderAccountTurnstileWidget();
}

function closeMemberDialog({ preservePending = false } = {}) {
  removeTurnstileWidget();
  removeAccountTurnstileWidget();
  $("#member-dialog").hidden = true;
  $(".member-dialog-panel").classList.remove("member-account-mode");
  document.body.classList.remove("member-dialog-open");
  if (!preservePending) {
    state.pendingAssetId = null;
    state.pendingRoute = "overview";
  }
}

function requestAssetAccess(assetId, route = "overview") {
  if (canAccessAsset(assetId)) return true;
  setAssetPicker(false);
  openMemberLogin(assetId, route);
  return false;
}

function setAssetPicker(open) {
  $("#asset-picker").hidden = !open;
  document.body.classList.toggle("picker-open", open);
  if (open) {
    $("#asset-count").textContent = `${readWatchlist().length} / 30`;
    setAssetPickerMessage("请选择分类并输入资产代码。");
    renderAssetSearchResults();
    $("#asset-category").focus();
  }
}

function clearCharts() {
  state.charts.forEach(({ chart, observer }) => {
    observer?.disconnect();
    chart?.remove?.();
  });
  state.charts.clear();
  for (const id of ["weekly-chart", "daily-chart", "dca-chart", "macro-chart"]) {
    const container = document.getElementById(id);
    if (container) container.replaceChildren();
  }
}

function syncPageMode() {
  const emptyWatchlist = readWatchlist().length === 0;
  const watchlistView = mobileLayout.matches && (locationContext().view === "watchlist" || emptyWatchlist);
  state.watchlistView = watchlistView;
  document.body.classList.toggle("watchlist-view", watchlistView);
  document.body.classList.toggle("empty-watchlist", emptyWatchlist);
  $('meta[name="theme-color"]').content = watchlistView ? "#061e2f" : "#f4f7fa";
  if (watchlistView) {
    document.body.classList.remove("methodology-view");
    document.title = "LZ-TrendScope · 观察列表";
    $$('[data-route]').forEach((link) => {
      link.classList.remove("active");
      link.removeAttribute("aria-current");
    });
  }
  return watchlistView;
}

function restoreWatchlistScroll() {
  window.requestAnimationFrame(() => window.scrollTo({ top: state.watchlistScrollY, behavior: "auto" }));
}

function syncRouteShell(route) {
  const methodologyView = route === "methodology";
  document.body.classList.toggle("methodology-view", methodologyView);
  if (methodologyView) {
    document.title = "LZ-TrendScope · 框架与数据";
  } else if (state.current) {
    document.title = `LZ-TrendScope · ${assets[state.assetId].name}观察`;
  }
}

function activateRoute() {
  let route = routeFromLocation();
  if ((isLegacyMacroObservation() && !["overview", "methodology"].includes(route)) || (isMacroAsset() && route === "dca")) {
    route = "overview";
    history.replaceState({ assetId: state.assetId, route }, "", routePath(route));
  }
  if (syncPageMode()) {
    renderWatchlist();
    updateRouteLinks();
    restoreWatchlistScroll();
    return;
  }
  syncRouteShell(route);
  $$('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== route; });
  $$('[data-route]').forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  updateRouteLinks();
  renderWatchlist();
  if (state.current) void ensureRouteData(route);
  if (route === "overview" && isLegacyMacroObservation() && state.daily?.series?.length) {
    void loadChartLibrary().then(() => requestAnimationFrame(renderMacroChart)).catch((error) => {
      $("#macro-chart").textContent = error.message;
    });
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function loadChartLibrary() {
  if (window.LightweightCharts) return Promise.resolve();
  if (chartLibraryPromise) return chartLibraryPromise;
  chartLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("vendor-lightweight-charts.js?v=0.6.0", SITE_ROOT);
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      chartLibraryPromise = null;
      reject(new Error("图表组件加载失败，请重试。"));
    };
    document.head.append(script);
  });
  return chartLibraryPromise;
}

function setRouteState(route, status, message = "") {
  const node = $(`[data-route-state="${route}"]`);
  if (!node) return;
  node.hidden = status === "ready";
  node.classList.toggle("error", status === "error");
  if (status === "loading") node.textContent = "正在加载本页详细数据…";
  if (status === "error") {
    node.innerHTML = `${esc(message || "本页详细数据暂时不可用。")}<button type="button" data-retry-route="${esc(route)}">重试</button>`;
  }
}

async function ensureRouteData(route, { force = false } = {}) {
  if (["overview", "methodology"].includes(route)) return;
  if (route === "dca" && !canUseDca()) return;
  const assetId = state.assetId;
  if (force) state.routeLoads.delete(route);
  if (state.routeLoads.has(route)) return state.routeLoads.get(route);
  const load = (async () => {
    setRouteState(route, "loading");
    if (route === "weekly") {
      state.weekly = force || !state.weekly
        ? await loadAssetResource(assetId, "weekly-series.json")
        : state.weekly;
      if (assetId !== state.assetId) return;
      renderWeekly();
      await loadChartLibrary();
      requestAnimationFrame(renderWeeklyChart);
    }
    if (route === "daily") {
      state.daily = force || !state.daily
        ? await loadAssetResource(assetId, "daily-series.json")
        : state.daily;
      if (assetId !== state.assetId) return;
      renderDaily();
      await loadChartLibrary();
      requestAnimationFrame(renderDailyChart);
    }
    if (route === "dca") {
      state.dca = force || !state.dca
        ? await loadAssetResource(assetId, "dca-series.json")
        : state.dca;
      if (assetId !== state.assetId) return;
      renderDca();
      if (!state.dca.historyLimited) {
        await loadChartLibrary();
        requestAnimationFrame(renderDcaChart);
      }
    }
    if (route === "fundamentals") {
      const fundamentalsPromise = force || !state.fundamentals
        ? loadAssetResource(assetId, "fundamentals.json")
        : Promise.resolve(state.fundamentals);
      const publicNewsPromise = assets[assetId]?.memberOnly
        ? Promise.resolve(null)
        : force || !state.news
          ? loadAssetResource(assetId, "news.json").catch(() => null)
          : Promise.resolve(state.news);
      const [fundamentals, publicNews] = await Promise.all([fundamentalsPromise, publicNewsPromise]);
      const news = (assets[assetId]?.memberOnly ? fundamentals.recentNews : publicNews) || {
        schemaVersion: "asset-news-v1", asset: assetId, status: "unavailable", items: [], warnings: [],
      };
      state.fundamentals = fundamentals;
      state.news = news;
      if (assetId !== state.assetId) return;
      renderFundamentals();
    }
    setRouteState(route, "ready");
  })().catch((error) => {
    state.routeLoads.delete(route);
    setRouteState(route, "error", error.message);
    console.error(error);
  });
  state.routeLoads.set(route, load);
  return load;
}

function signalClass(value) {
  const text = String(value || "");
  if (/支持|顺风|偏强|多头|牛市|绿灯|S2/.test(text)) return "support";
  if (/压力|逆风|压制|偏弱|熊市|红灯|S4/.test(text)) return "pressure";
  return "neutral";
}

function metricPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function bandStatusTone(status) {
  const text = String(status || "");
  if (/低位金叉|趋势金叉/.test(text)) return { className: "band-tone-green", color: "#06a94f" };
  if (/上行趋势/.test(text)) return { className: "band-tone-blue", color: "#1769dc" };
  if (/超卖观察/.test(text)) return { className: "band-tone-orange", color: "#f36b00" };
  if (/观察等待|高位保护/.test(text)) return { className: "band-tone-amber", color: "#d99822" };
  if (/下行风险|高位死叉/.test(text)) return { className: "band-tone-red", color: "#f23845" };
  return { className: "band-tone-neutral", color: "#7571b5" };
}

function returnText(value) {
  if (!Number.isFinite(Number(value))) return "待观察";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${fmt(number, 2)}%`;
}

function returnTone(value) {
  if (!Number.isFinite(Number(value))) return "pending";
  return Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
}

function updateHeader() {
  const { current } = state;
  const presentation = assets[state.assetId];
  const quote = current.quote;
  const marketFreshness = current.quality?.marketFreshness;
  document.body.dataset.asset = state.assetId;
  document.body.classList.toggle("macro-asset", isMacroAsset());
  document.body.classList.toggle("macro-observation", isLegacyMacroObservation());
  document.title = `LZ-TrendScope · ${presentation.name}观察`;
  $("#asset-symbol").textContent = presentation.code;
  $("#asset-name").textContent = presentation.name;
  $("#mobile-detail-title").textContent = isMacroAsset()
    ? `${presentation.code} · ${presentation.name}`
    : `${presentation.code}/${presentation.currency || quote.currency || "USD"} · ${presentation.name}`;
  $("#overview-title").textContent = `${presentation.name}状态总览`;
  $("#footer-label").textContent = `LZ-TrendScope · ${presentation.name}观察`;
  $("#module-tabs").setAttribute("aria-label", `${presentation.name}分析模块`);
  $("#weekly-chart").setAttribute("aria-label", `${presentation.name}周线价格图`);
  $("#daily-chart").setAttribute("aria-label", `${presentation.name}日线价格图`);
  $("#dca-chart").setAttribute("aria-label", `${presentation.name}价格与 LZ-DCA 走势图`);
  const delta = Number(quote.price) - Number(quote.previousClose);
  const percent = Number(quote.previousClose) ? (delta / Number(quote.previousClose)) * 100 : 0;
  $("#asset-benchmark").textContent = ["cn_equity", "hk_equity"].includes(presentation.category)
    ? `${current.asset.symbol} · ${presentation.category === "cn_equity" ? "A股" : "港股"}`
    : current.asset.technicalBenchmark;
  $("#quote-price").textContent = fmt(quote.price, isMacroAsset() ? 2 : 1);
  $(".quote-label").textContent = marketFreshness?.sourceFresh === false
    ? isMacroAsset() ? "数据延迟 · 最近观测值" : "行情延迟 · 最近可用收盘"
    : isMacroAsset() ? "最新观测值" : "最新确认收盘";
  $("#quote-currency").textContent = quote.currency;
  const change = $("#quote-change");
  change.textContent = isMacroAsset()
    ? current.macro.code === "US10Y"
      ? `${delta >= 0 ? "+" : ""}${fmt(delta * 100, 1)} bp · 较上一观测日`
      : `${delta >= 0 ? "+" : ""}${fmt(delta, 2)} 点 · ${percent >= 0 ? "+" : ""}${fmt(percent, 2)}%`
    : `${delta >= 0 ? "+" : ""}${fmt(delta, 1)} · ${percent >= 0 ? "+" : ""}${fmt(percent, 2)}%`;
  change.className = isMacroAsset() ? "" : delta >= 0 ? "positive" : "negative";
  $(".hero-meta dt").textContent = isLegacyMacroObservation() ? "观测日期" : "日线日期";
  $("#daily-date").textContent = fmtDate(current.daily.asOf);
  $("#weekly-date").textContent = fmtDate(current.weekly?.asOf);
  const generatedAt = new Date(current.generatedAt);
  $("#generated-date").textContent = generatedAt.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
  }).replaceAll("/", "-");
  $("#generated-time").textContent = generatedAt.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  $("#generated-at").title = generatedAt.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });
  renderWatchlist();
}

function renderMacroOverview() {
  const current = state.current;
  const yieldSeries = current.macro.code === "US10Y";
  const delta = Number(current.quote.price) - Number(current.quote.previousClose);
  const percent = Number(current.quote.previousClose) ? delta / Number(current.quote.previousClose) * 100 : 0;
  $("#macro-title").textContent = current.asset.name;
  $("#overview-title").textContent = `${current.asset.name}宏观观察`;
  $("#macro-value").textContent = `${fmt(current.quote.price, 2)} ${current.macro.unit}`;
  $("#macro-delta-label").textContent = yieldSeries ? "较上一观测日 · 基点" : "较上一观测日 · 点数";
  $("#macro-delta").textContent = yieldSeries
    ? `${delta >= 0 ? "+" : ""}${fmt(delta * 100, 1)} bp`
    : `${delta >= 0 ? "+" : ""}${fmt(delta, 2)} 点 (${percent >= 0 ? "+" : ""}${fmt(percent, 2)}%)`;
  $("#macro-date").textContent = fmtDate(current.quote.date);
  $("#macro-chart-title").textContent = `${current.asset.name} · 历史日值`;
  $("#macro-chart").setAttribute("aria-label", `${current.asset.name}历史日值折线图`);
  $("#macro-description").textContent = yieldSeries
    ? "美国10年期国债收益率，单位为百分比；官方日值不含真实开高低收和成交量。"
    : "ICE 美元指数的日度收盘观察值；这不是美联储广义美元指数。";
  const freshness = current.quality?.marketFreshness;
  $("#macro-source-note").textContent = `数据源：${current.source.name} · 截至 ${fmtDate(current.quote.date)}${freshness?.sourceFresh === false ? " · 数据源更新延迟" : ""}。技术分析快照正在更新，宏观资产不提供定投建议。`;
}

function renderMacroChart() {
  const id = "macro-chart";
  if (state.charts.has(id) || !state.daily?.series?.length) return;
  const container = document.getElementById(id);
  if (!container || container.clientWidth === 0) return;
  const api = chartApi(container, "macro");
  if (!api) return;
  const line = api.addLine({ color: "#2478a5", lineWidth: 2, priceLineVisible: false });
  line.setData(state.daily.series.map((point) => ({ time: point.date, value: Number(point.value) })));
  api.chart.timeScale().fitContent();
  const observer = new ResizeObserver(() => api.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
  observer.observe(container);
  state.charts.set(id, { ...api, line, observer });
}

function renderOverview() {
  const { current } = state;
  $("#overview-headline").textContent = current.synthesis.headline;
  const weeklyConfirmed = current.weekly.current.confirmed || {};
  const weeklyStage = Number(weeklyConfirmed.primary || weeklyConfirmed.stage);
  const weeklyStageTitle = stagePresentation[weeklyStage]?.title || "";
  const weeklyLabel = [weeklyConfirmed.label || weeklyConfirmed.code || "未确认", weeklyStageTitle].filter(Boolean).join(" ");
  const fundamentalHealth = current.fundamentals.health || {};
  const staleCount = Number(fundamentalHealth.staleCount || current.quality.dataHealth?.staleFundamentalCount || 0);
  const metrics = [
    ["#overview-weekly-card", "#overview-weekly", "#overview-weekly-note", weeklyLabel, `完成周线 · ${fmtDate(current.weekly.asOf)}`],
    ["#overview-daily-card", "#overview-daily", "#overview-daily-note", current.daily.summary.fusion.status, `${current.daily.summary.traffic.status} · ${fmtDate(current.daily.asOf)}`],
    ["#overview-fundamental-card", "#overview-fundamental", "#overview-fundamental-note", current.fundamentals.regime, staleCount ? `${staleCount} 项沿用上一有效值` : `更新至 ${fmtDate(current.fundamentals.asOf)}`],
  ];
  metrics.forEach(([cardSelector, valueSelector, noteSelector, value, note]) => {
    const card = $(cardSelector);
    card.classList.remove("support", "pressure", "neutral");
    card.classList.add(signalClass(value));
    $(valueSelector).textContent = value;
    $(noteSelector).textContent = note;
  });
  const changeSummary = current.changeSummary || {
    direction: "stable",
    label: current.daily.change,
    items: current.recentChanges || [],
  };
  const changeBox = $("#overview-change");
  changeBox.classList.remove("improving", "weakening", "mixed", "stable");
  changeBox.classList.add(changeSummary.direction || "stable");
  $("#overview-change-label").textContent = changeSummary.label;
  $("#synthesis-title").textContent = current.synthesis.title || "当前主导逻辑";
  $("#tension-copy").textContent = current.synthesis.tension;
  const changes = changeSummary.items || current.recentChanges || [];
  $("#change-timeline").innerHTML = changes.length ? changes.map((item) => `
    <li class="${esc(item.direction || "changed")}">
      <div><strong>${esc(item.title)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ""}</div>
      <time datetime="${esc(item.date)}">${esc(fmtDate(item.date))}</time>
    </li>
  `).join("") : '<li class="empty-change">完成周期内暂无关键状态变化。</li>';
  const conditions = current.validationConditions || [];
  $("#validation-list").innerHTML = conditions.length ? conditions.map((item) => `
    <div class="validation-item ${esc(item.tone || "watch")}">
      <span>${esc(item.label)}</span>
      <strong>${esc(item.condition)}</strong>
    </div>
  `).join("") : '<div class="validation-item watch"><span>等待更新</span><strong>下一次数据生成后补充验证条件</strong></div>';
  const health = current.quality.dataHealth || {
    status: current.quality.status,
    label: current.quality.status === "ok" ? "数据正常" : "数据需注意",
    staleFundamentals: [],
  };
  $("#quality-summary").textContent = health.label;
  const qualityDetails = [];
  if (health.staleFundamentals?.length) {
    qualityDetails.push(`基本面中的${health.staleFundamentals.join("、")}未在本轮更新，页面沿用各自上一有效值。`);
  }
  if (health.pendingFundamentalGroups?.length) {
    qualityDetails.push(`${health.pendingFundamentalGroups.join("、")}尚未接入稳定且具备展示条件的数据源，当前不参与基本面方向判断。`);
  }
  if (current.quality.warnings?.length) qualityDetails.push(...current.quality.warnings);
  $("#quality-detail").textContent = qualityDetails.length
    ? qualityDetails.join(" ")
    : `行情、周线和日线数据已更新至 ${fmtDate(current.daily.asOf)}。`;
}

function weeklyDisplayExplanation(value) {
  return String(value || "")
    .replace(/\s*52周位置仍与目标阶段存在分歧。?/g, "")
    .trim();
}

function renderWeekly() {
  const current = state.current.weekly.current;
  const confirmed = current.confirmed || {};
  const observation = current.observation || {};
  const confirmedLabel = confirmed.label || confirmed.code || "未确认";
  const currentPrimaryStage = Number(confirmed.primary || confirmed.stage);
  const currentStageClass = stagePresentation[currentPrimaryStage] ? `stage-s${currentPrimaryStage}` : "";
  const currentStageTitle = stagePresentation[currentPrimaryStage]?.title || "";
  const observationPrimaryStage = Number(observation.primaryStage || observation.primary || observation.rawStage);
  const observationStageClass = stagePresentation[observationPrimaryStage] ? `stage-s${observationPrimaryStage}` : "";
  const observationLabel = stagePresentation[observationPrimaryStage]?.code || "未确认";
  const slope = Number(current.slope);
  const ma30Direction = Number.isFinite(slope) ? (slope > 0 ? "上升" : slope < 0 ? "下降" : "持平") : "—";
  const ma30Slope = Number.isFinite(slope)
    ? `${(slope * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`
    : "—";
  const ma30TrendClass = slope > 0 ? "up" : slope < 0 ? "down" : "flat";
  const explanation = weeklyDisplayExplanation(current.explanation || current.observation?.reason || "");
  $("#weekly-stats").innerHTML = `
    <span class="panel-kicker">CURRENT STAGE</span>
    <div class="big-state ${currentStageClass}"><span>${esc(confirmedLabel)}</span>${currentStageTitle ? `<small>${esc(currentStageTitle)}</small>` : ""}</div>
    <dl class="stat-list">
      <div><dt>当前阶段</dt><dd class="weekly-stage-value ${currentStageClass}">${esc(confirmedLabel)}</dd></div>
      <div><dt>主阶段持续</dt><dd>${Number.isFinite(Number(confirmed.weeks)) ? `${esc(confirmed.weeks)}周` : "—"}</dd></div>
      <div><dt>本周观察</dt><dd class="weekly-stage-value ${observationStageClass}">${esc(observationLabel)}</dd></div>
      <div><dt>MA10</dt><dd>${fmt(current.ma10, 1)}</dd></div>
      <div><dt>MA30</dt><dd>${fmt(current.ma30, 1)}</dd></div>
      <div><dt>MA30趋势</dt><dd class="weekly-ma30-trend ${ma30TrendClass}">${esc(ma30Direction)}<span>｜5周斜率 ${esc(ma30Slope)}</span></dd></div>
      <div><dt>阶段置信度</dt><dd>${fmt(current.confidence, 0)}%</dd></div>
    </dl>
    <div class="metric-track" aria-label="阶段置信度 ${fmt(current.confidence, 0)}%"><span style="width: ${metricPercent(current.confidence)}%"></span></div>
    <p class="explanation">${esc(explanation)}</p>
  `;
  $("#weekly-evidence").innerHTML = (current.evidence || []).map((item) => `
    <div class="evidence-item">
      <strong>${esc(item.label)}</strong>
      <span class="tag ${esc(item.state === "support" ? "support" : item.state === "warning" ? "warning" : "neutral")}">${esc(item.value)}</span>
      <p>${esc(item.detail)}</p>
    </div>
  `).join("") || '<p class="muted-copy">当前没有可展示的阶段证据。</p>';
  $("#stage-history").innerHTML = [...(state.weekly.stageHistory || [])].slice(-6).reverse().map((item) => `
    <div class="history-item stage-bg-s${stageNumber(item.newStage) || 0}">
      <strong>${esc(item.originalStage)} → ${esc(item.newStage)}</strong>
      <span>${esc(fmtDate(item.date))}</span>
      <p>阶段转换参考价 ${fmt(item.conversionPrice, 1)}</p>
    </div>
  `).join("") || '<p class="muted-copy">暂无阶段变化记录。</p>';
}

function renderDaily() {
  const summary = state.current.daily.summary;
  const fusionTone = signalClass(summary.fusion.status);
  const bullBearTone = signalClass(summary.bullBear.status);
  const trafficTone = signalClass(summary.traffic.status);
  const bandTone = bandStatusTone(summary.band.status).className;
  const latestBar = state.daily.series?.at(-1) || {};
  const ma200Distance = Number(latestBar.ma200)
    ? ((Number(latestBar.close) / Number(latestBar.ma200)) - 1) * 100
    : null;
  $("#daily-summary").innerHTML = `
    <span class="panel-kicker">FUSION STATUS</span>
    <div class="big-state ${fusionTone}">${esc(summary.fusion.status)}</div>
    <dl class="stat-list">
      <div><dt>融合得分</dt><dd>${fmt(summary.fusion.score, 0)}</dd></div>
      <div><dt>牛熊状态</dt><dd class="daily-state-value ${bullBearTone}">${esc(summary.bullBear.status)}</dd></div>
      <div><dt>趋势交通灯</dt><dd class="daily-state-value ${trafficTone}">${esc(summary.traffic.status)}</dd></div>
      <div><dt>波动状态</dt><dd class="daily-state-value ${bandTone}">${esc(summary.band.status)}</dd></div>
      <div><dt>MA200偏离</dt><dd class="${returnTone(ma200Distance)}">${Number.isFinite(ma200Distance) ? `${ma200Distance > 0 ? "+" : ""}${fmt(ma200Distance, 2)}%` : "—"}</dd></div>
    </dl>
    <p class="explanation">${esc(summary.fusion.advice)}</p>
  `;
  $("#daily-change-summary").innerHTML = `
    <span>与上一日相比</span>
    <strong>${esc(state.current.daily.change)}</strong>
  `;
  const history = [...(state.daily.bandHistory || [])].reverse();
  $("#band-history-count").textContent = `最近 ${history.length} 条`;
  $("#band-history-list").innerHTML = history.map((item) => {
    const tone = bandStatusTone(item.status);
    return `
      <tr>
        <td><time datetime="${esc(item.date)}">${esc(fmtDate(item.date))}</time></td>
        <td><span class="band-status-chip ${tone.className}">${esc(item.status)}</span></td>
        <td class="number-cell">${fmt(item.price, 1)}</td>
        <td class="number-cell ${returnTone(item.return7)}">${esc(returnText(item.return7))}</td>
        <td class="number-cell ${returnTone(item.return14)}">${esc(returnText(item.return14))}</td>
        <td class="action-cell">${esc(item.action || "—")}</td>
      </tr>
    `;
  }).join("") || '<tr><td colspan="6" class="empty-history">暂无历史状态变化。</td></tr>';
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

function newsTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(parsed);
}

function recentNewsPanelMarkup() {
  return `
    <article class="panel recent-news-panel" id="recent-news-panel">
      <div class="recent-news-heading">
        <div><span class="panel-kicker">RECENT NEWS</span><h2>最近重要动态</h2></div>
        <span class="news-asof" id="news-asof">—</span>
      </div>
      <div class="recent-news-list" id="recent-news-list"></div>
      <p class="news-policy" id="news-policy">最多展示 5 条与资产直接相关的重要动态，优先采用可核验的中文来源，保留原文链接，不参与基本面方向评分。</p>
    </article>
  `;
}

function renderRecentNews() {
  const news = state.news || { status: "unavailable", items: [] };
  const items = news.items || [];
  const stateLabels = {
    ok: `更新至 ${fmtDate(news.asOf || news.generatedAt)}`,
    empty: `更新至 ${fmtDate(news.asOf || news.generatedAt)}`,
    stale: `沿用至 ${fmtDate(news.asOf || news.generatedAt)}`,
    unavailable: "暂不可用",
  };
  $("#news-asof").textContent = stateLabels[news.status] || "—";
  if (!items.length) {
    $("#recent-news-list").innerHTML = `<div class="news-empty">${
      news.status === "unavailable"
        ? "最近重要动态暂时无法获取，其他基本面数据不受影响。"
        : "最近 30 天未筛选到符合条件的重要动态，不使用低价值内容补足数量。"
    }</div>`;
    return;
  }
  $("#recent-news-list").innerHTML = items.map((item) => `
    <a class="recent-news-item" href="${esc(safeExternalUrl(item.url))}" target="_blank" rel="noopener noreferrer">
      <div class="news-item-main">
        <div class="news-item-meta"><span>${esc(item.eventType || "资产动态")}</span><time datetime="${esc(item.publishedAt)}">${esc(newsTime(item.publishedAt))}</time></div>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.selectionReason || "与该资产直接相关的重要动态。")}</p>
      </div>
      <div class="news-item-source"><span>${esc(item.publisher || "来源待确认")}</span><strong>查看原文 ↗</strong></div>
    </a>
  `).join("");
}

function renderFundamentals() {
  const fundamentals = state.current.fundamentals;
  $("#fundamental-summary").textContent = fundamentals.summary;
  const factorById = new Map(fundamentals.factors.map((item) => [item.id, item]));
  const factorChanges = (item) => {
    const changes = item.changes?.length
      ? item.changes
      : Number.isFinite(Number(item.change5Observations))
        ? [{ label: "五个观察值", value: Number(item.change5Observations), unit: item.unit }]
        : [];
    return changes.map((change) => {
      const value = Number(change.value);
      const signed = value > 0 ? `+${fmt(value, 2)}` : fmt(value, 2);
      const unit = change.unit === "%" ? "%" : ` ${esc(change.unit || "")}`;
      return `<span class="factor-change-chip ${value > 0 ? "positive" : value < 0 ? "negative" : ""}">${esc(change.label)} ${signed}${unit}</span>`;
    }).join("");
  };
  const factorRow = (item) => {
    const pending = item.status === "pending";
    const notApplicable = item.status === "not_applicable";
    const unavailable = pending || notApplicable;
    const stale = item.status === "stale";
    const sourceId = item.source?.seriesId ? ` · ${esc(item.source.seriesId)}` : "";
    const statusLabel = notApplicable ? "不适用" : pending ? "待接入" : stale ? "沿用旧值" : impactLabel[item.impact] || "暂不明确";
    return `
      <div class="fundamental-factor ${unavailable ? "pending-factor" : ""} ${notApplicable ? "not-applicable-factor" : ""}">
        <div class="fundamental-factor-heading">
          <h4>${esc(item.label)}</h4>
          <span class="tag ${esc(item.impact || "unavailable")}">${esc(statusLabel)}</span>
        </div>
        <div class="fundamental-factor-reading">
          <strong>${unavailable ? statusLabel : `${fmt(item.value, 2)} <small>${esc(item.unit || "")}</small>`}</strong>
          <div class="factor-change-list">${factorChanges(item)}</div>
        </div>
        <p>${esc(item.explanation)}</p>
        <div class="factor-source"><span>${esc(item.source?.name || "来源待确认")}${sourceId}</span><span>${esc(item.reportedPeriod ? `报告期 ${fmtDate(item.reportedPeriod)}` : fmtDate(item.observationDate))}</span></div>
      </div>
    `;
  };
  const groups = fundamentals.groups || [];
  const factorGrid = $("#factor-grid");
  factorGrid.classList.toggle("fundamental-group-grid", Boolean(groups.length));
  const cards = groups.length ? groups.map((group) => ({
    weight: Math.max(2, 1.35 + group.factorIds.length),
    html: `
      <article class="fundamental-group group-${esc(group.id)} ${esc(group.tone || "neutral")}">
        <header class="fundamental-group-header">
          <div><span class="panel-kicker">${esc(group.eyebrow)}</span><h3>${esc(group.label)}</h3></div>
          <span class="group-state ${esc(group.tone || "neutral")}">${esc(group.state)}</span>
        </header>
        <p class="fundamental-group-description">${esc(group.description)}</p>
        <div class="fundamental-factor-list">${group.factorIds.map((id) => factorById.get(id)).filter(Boolean).map(factorRow).join("")}</div>
      </article>
    `,
  })) : fundamentals.factors.map((item) => ({
    weight: 2.5,
    html: `
      <article class="factor-card ${esc(item.impact)}">
        <div class="factor-top"><h3>${esc(item.label)}</h3><span class="tag ${esc(item.impact)}">${esc(impactLabel[item.impact] || "暂不明确")}</span></div>
        <div class="factor-value">${fmt(item.value, 2)} <small>${esc(item.unit)}</small></div>
        <div class="factor-change-list">${factorChanges(item)}</div>
        <p>${esc(item.explanation)}</p>
        <div class="factor-source"><span>${esc(item.source.name)} · ${esc(item.source.seriesId)}</span><span>${esc(fmtDate(item.observationDate))}</span></div>
      </article>
    `,
  }));
  const labels = {
    "real-yield": "实际利率",
    "nominal-yield": "名义利率",
    "inflation-expectations": "通胀预期",
    "broad-dollar": "广义美元",
    "gold-etf-flows": "黄金ETF资金流",
    "cftc-positioning": "CFTC持仓",
    "central-bank-demand": "央行购金",
    "china-premium": "中国溢价",
    "event-calendar": "宏观事件日历",
    "financial-conditions": "美国金融条件",
    "spot-etf-flows": "现货ETF资金流",
    "stablecoin-supply": "稳定币总供应",
    "core-stablecoin-supply": "USDT + USDC 供应",
    "btc-market-liquidity": "BTC 成交活跃度样本",
    "long-term-holder-supply": "长期持有者供应",
    "exchange-balance": "交易所余额",
    "exchange-netflow": "交易所净流量",
  };
  const coverage = state.fundamentals.coverage || {};
  const implemented = coverage.implemented || [];
  const coverageCard = `
  <article class="panel coverage-panel" id="coverage-panel">
    <div class="panel-heading"><span class="panel-kicker">COVERAGE</span><h2>基本面覆盖进度</h2></div>
    <div class="coverage-columns">
      <div><h3>已经接入</h3><ul>${implemented.map((key) => `<li>${esc(labels[key] || key)}</li>`).join("") || "<li>暂无已接入数据</li>"}</ul></div>
    </div>
  </article>
  `;
  if (mobileLayout.matches) {
    factorGrid.innerHTML = [recentNewsPanelMarkup(), ...cards.map((card) => card.html), coverageCard].join("");
    renderRecentNews();
    return;
  }
  const columns = [[], []];
  const columnWeights = [Math.max(3, 1.4 + (state.news?.items?.length || 0) * 1.05), 0];
  columns[0].push(recentNewsPanelMarkup());
  cards.forEach((card) => {
    const column = columnWeights[0] <= columnWeights[1] ? 0 : 1;
    columns[column].push(card.html);
    columnWeights[column] += card.weight;
  });
  const coverageColumn = columnWeights[0] <= columnWeights[1] ? 0 : 1;
  columns[coverageColumn].push(coverageCard);
  factorGrid.innerHTML = columns.map((column) => `<div class="fundamental-column">${column.join("")}</div>`).join("");
  renderRecentNews();
}

function dcaTierClass(value) {
  const tier = Number(value);
  return [0, 20, 40, 60, 80, 100].includes(tier) ? `tier-${tier}` : "tier-40";
}

function renderDcaZoneStatistics(dca, years = state.dcaRangeYears) {
  const safeYears = Math.min(4, Math.max(1, Number(years) || 1));
  const fullSeries = dca?.series || [];
  const latestDate = fullSeries.at(-1)?.date || fullSeries.at(-1)?.time;
  const cutoff = latestDate ? shiftIsoMonths(latestDate, -safeYears * 12) : "";
  const selectedSeries = cutoff
    ? fullSeries.filter((item) => String(item.date || item.time) >= cutoff)
    : fullSeries;
  const zoneDefinitions = [
    { source: "抄底区", label: "低温区", className: "zone-cold" },
    { source: "定投区", label: "定投区", className: "zone-invest" },
    { source: "观望区", label: "观望区", className: "zone-watch" },
    { source: "高温区", label: "高温区", className: "zone-hot" },
  ];
  $("#dca-statistics-period").textContent = dca?.historyLimited ? "历史不足" : `近${safeYears}年`;
  $("#dca-tier-statistics").innerHTML = selectedSeries.length ? zoneDefinitions.map((item) => {
    const days = selectedSeries.filter((point) => point.zone === item.source).length;
    return `
    <article class="dca-tier-card ${item.className}">
      <span>${item.label}</span>
      <strong>${fmt(days, 0)} 天</strong>
      <p>${fmt(days / selectedSeries.length * 100, 1)}%</p>
    </article>
  `;
  }).join("") : `<p class="dca-empty-copy">有效历史不足，暂不生成区间统计。</p>`;
}

function renderDca() {
  const dca = state.dca;
  if (!dca) return;
  const rangeSelect = $("#dca-range-select");
  if (rangeSelect) rangeSelect.value = String(state.dcaRangeYears);
  const current = dca.current || {};
  const currency = state.current?.quote?.currency || assets[state.assetId]?.currency || "USD";
  const historyLimited = Boolean(dca.historyLimited);
  const reasons = current.heatConfirmed ? current.heatReasons : current.coldConfirmed ? current.coldReasons : [];
  $("#dca-current").innerHTML = `
    <span class="panel-kicker">TODAY'S DCA</span>
    <h2 class="dca-current-title">今日定投建议</h2>
    <div class="dca-current-value ${esc(dcaTierClass(current.amountTier))}">
      <strong>${fmt(current.lzDca, 2)}</strong><span>LZ-DCA</span>
    </div>
    <div class="dca-current-zone ${esc(dcaTierClass(current.amountTier))}">
      <span>${esc(current.zone || "待判断")}</span><strong>${esc(current.amountLabel || "—")} · ${fmt(current.amountTier, 0)}</strong>
    </div>
    <dl class="stat-list">
      <div><dt>确认日期</dt><dd>${esc(fmtDate(current.date || dca.asOf))}</dd></div>
      <div><dt>确认收盘</dt><dd>${fmt(current.price, 2)} ${esc(currency)}</dd></div>
    </dl>
    <div class="dca-recommendation ${esc(dcaTierClass(current.amountTier))}">
      <strong>规则建议</strong>
      <p>${esc(current.recommendation || "等待完成日线后更新。")}</p>
      <small>${esc(current.zoneAction || "")}</small>
    </div>
    ${reasons.length ? `<p class="dca-confirmation">严格信号确认：${reasons.map(esc).join("；")}</p>` : ""}
    ${historyLimited ? `<p class="dca-history-warning">${esc((dca.warnings || [])[0] || "历史数据不足，仅展示当前建议。")}</p>` : ""}
  `;

  renderDcaZoneStatistics(dca);

  const signals = [...(dca.signals || [])].sort((left, right) => String(right.date).localeCompare(String(left.date)));
  $("#dca-signal-count").textContent = historyLimited ? "历史不足" : `${signals.length} 个确认信号`;
  $("#dca-signal-list").innerHTML = signals.length ? signals.map((item) => `
    <tr>
      <td>${esc(fmtDate(item.date))}</td>
      <td class="number-cell">${fmt(item.lzDca, 2)}</td>
      <td class="number-cell">${fmt(item.price, 2)}</td>
      <td><span class="dca-signal-chip ${item.type === "low" ? "low" : "high"}">${esc(item.label)}</span></td>
      <td class="dca-signal-detail">${item.reasons?.length ? esc(item.reasons.join("；")) : "—"}</td>
    </tr>
  `).join("") : `<tr><td class="empty-history" colspan="5">${historyLimited ? "有效历史不足，暂不生成历史信号。" : "近4年没有满足严格确认条件的重要信号。"}</td></tr>`;

  if (historyLimited) {
    $("#dca-chart").innerHTML = `<div class="dca-chart-unavailable"><strong>历史图表暂不可用</strong><span>LZ-DCA V1.1 需要至少 ${fmt(dca.historyMeta?.requiredForFullHistory, 0)} 根有效日线生成可比历史。</span></div>`;
  }
}

function renderMethodology() {
  if (isLegacyMacroObservation() && state.current?.macro) {
    const { current } = state;
    const yieldSeries = current.macro.code === "US10Y";
    $("#provenance-panel").innerHTML = `
      <div class="panel-heading"><span class="panel-kicker">PROVENANCE</span><h2>可追溯信息</h2></div>
      <div class="provenance-grid">
        <div class="code-block">观察项<br>${esc(current.asset.name)}<br>${esc(current.macro.code)}</div>
        <div class="code-block">数据源<br>${esc(current.source.name)}<br>${esc(current.source.providerSymbol)}</div>
        <div class="code-block">数值单位<br>${yieldSeries ? "收益率，百分比" : "美元指数，点"}<br>逐日观察值</div>
        <div class="code-block">日期原则<br>只显示已完成日值<br>保留数据源发布日期差异</div>
        <div class="code-block">数据边界<br>这是旧版单值快照<br>等待真实 OHLC 技术分析更新，定投保持关闭</div>
        <div class="code-block">序列身份<br>${yieldSeries ? "FRED DGS10" : "ICE DXY，经 Yahoo Finance 获取"}<br>不使用其他美元或债券序列替代</div>
      </div>
    `;
    return;
  }
  const engines = state.current?.engines || {
    weekly: { name: "LZ-4Stage", version: "LZAS-W-1.0.0" },
    daily: { name: "LZ-Status-V3", version: "LZAS-D-1.0.0" },
    dca: { name: "LZ-DCA", version: "LZAS-DCA-1.1.0", baseline: "v1.1" },
  };
  $("#provenance-panel").innerHTML = `
    <div class="panel-heading"><span class="panel-kicker">PROVENANCE</span><h2>可追溯信息</h2></div>
    <div class="provenance-grid">
      <div class="code-block">周线引擎<br>${esc(engines.weekly.name)}<br>内部版本: ${esc(engines.weekly.version)}</div>
      <div class="code-block">日线引擎<br>${esc(engines.daily.name)}<br>内部版本: ${esc(engines.daily.version)}</div>
      ${isMacroAsset() ? '<div class="code-block">宏观分析边界<br>定投建议已关闭<br>无适用成交量，不含成交量加分</div>' : `<div class="code-block">定投引擎<br>LZ-DCA V1.1<br>内部版本: ${esc(engines.dca?.version || "LZAS-DCA-1.1.0")}</div>`}
      <div class="code-block">统一输入原则<br>同一份标准化真实 OHLC<br>${isMacroAsset() ? "周线和日线同源；US10Y 分析收益率而非债券价格" : "周线、日线与定投同源"}</div>
      <div class="code-block">周期确认原则<br>只使用完成周线<br>只使用确认收盘日线</div>
      <div class="code-block">数据状态原则<br>缺失与沿用明确标识<br>不把缺失数据解释为中性</div>
      <div class="code-block">自动更新机制<br>GitHub 08:08 主更新<br>Cloudflare 08:28 兜底检查</div>
    </div>
  `;
}

function chartApi(container, kind) {
  if (!window.LightweightCharts) return null;
  const uiFont = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim();
  const chart = window.LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: { background: { color: "transparent" }, textColor: "#6e8292", fontFamily: uiFont },
    grid: { vertLines: { color: "rgba(16,40,59,.055)" }, horzLines: { color: "rgba(16,40,59,.055)" } },
    rightPriceScale: {
      borderColor: "rgba(16,40,59,.12)",
      scaleMargins: kind === "daily" ? { top: 0.08, bottom: 0.3 } : { top: 0.14, bottom: 0.1 },
    },
    leftPriceScale: {
      visible: kind === "dca",
      borderColor: "rgba(16,40,59,.12)",
      scaleMargins: { top: 0.08, bottom: kind === "dca" ? 0.1 : 0.08 },
    },
    timeScale: { borderColor: "rgba(16,40,59,.12)", timeVisible: kind === "daily" || kind === "dca" },
    crosshair: { vertLine: { color: "rgba(36,120,165,.36)" }, horzLine: { color: "rgba(36,120,165,.36)" } },
  });
  const addCandle = (options) => chart.addCandlestickSeries
    ? chart.addCandlestickSeries(options)
    : chart.addSeries(window.LightweightCharts.CandlestickSeries, options);
  const addLine = (options) => chart.addLineSeries
    ? chart.addLineSeries(options)
    : chart.addSeries(window.LightweightCharts.LineSeries, options);
  return { chart, addCandle, addLine };
}

function installDataZoomBoundary(container, chart, pointCount) {
  const apply = () => {
    const timeScale = chart.timeScale();
    const plotWidth = Number(timeScale.width?.()) || container.clientWidth;
    if (!plotWidth || !pointCount) return;
    timeScale.applyOptions({
      fixLeftEdge: true,
      minBarSpacing: Math.max(0.5, plotWidth / pointCount),
    });
  };
  apply();
  requestAnimationFrame(apply);
  return apply;
}

function stageNumber(value) {
  const match = String(value ?? "").match(/[1-4]/);
  return match ? Number(match[0]) : null;
}

function stageSegments(series) {
  const segments = [];
  series.forEach((bar, index) => {
    const stage = stageNumber(bar.stage);
    const previous = segments.at(-1);
    if (previous?.stage === stage) {
      previous.end = index;
    } else if (stage) {
      segments.push({ stage, start: index, end: index });
    }
  });
  return segments;
}

function seriesWithConfirmedStages(series, history) {
  const transitions = [...(history || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let transitionIndex = 0;
  let confirmedStage = stageNumber(series[0]?.stage);
  return series.map((bar) => {
    const date = bar.time || bar.date;
    while (transitionIndex < transitions.length && transitions[transitionIndex].date <= date) {
      confirmedStage = stageNumber(transitions[transitionIndex].newStage) || confirmedStage;
      transitionIndex += 1;
    }
    return { ...bar, stage: confirmedStage };
  });
}

function trailingSeriesByMonths(series, months) {
  const latestDate = series.at(-1)?.time || series.at(-1)?.date;
  if (!latestDate || !months) return series;
  const cutoff = shiftIsoMonths(latestDate, -months);
  const firstInside = series.findIndex((bar) => String(bar.time || bar.date) >= cutoff);
  if (firstInside < 0) return series;
  return series.slice(Math.max(0, firstInside - 1));
}

function installStageBackground(container, chart, series) {
  const backgroundLayer = document.createElement("div");
  const labelLayer = document.createElement("div");
  backgroundLayer.className = "stage-background-layer";
  labelLayer.className = "stage-label-layer";
  container.prepend(backgroundLayer);
  container.append(labelLayer);
  const segments = stageSegments(series);

  const redraw = () => {
    const coordinates = series.map((bar) => chart.timeScale().timeToCoordinate(bar.time || bar.date));
    if (coordinates.filter(Number.isFinite).length < 2) return;
    backgroundLayer.replaceChildren();
    labelLayer.replaceChildren();
    segments.forEach((segment) => {
      const startCoordinate = coordinates[segment.start];
      const endCoordinate = coordinates[segment.end];
      if (!Number.isFinite(startCoordinate) || !Number.isFinite(endCoordinate)) return;
      const before = coordinates[segment.start - 1];
      const after = coordinates[segment.end + 1];
      const left = Number.isFinite(before)
        ? (before + startCoordinate) / 2
        : startCoordinate - Math.abs((coordinates[segment.start + 1] ?? startCoordinate + 8) - startCoordinate) / 2;
      const right = Number.isFinite(after)
        ? (endCoordinate + after) / 2
        : endCoordinate + Math.abs(endCoordinate - (coordinates[segment.end - 1] ?? endCoordinate - 8)) / 2;
      const clippedLeft = Math.max(0, left);
      const clippedRight = Math.min(container.clientWidth, right);
      const width = clippedRight - clippedLeft;
      if (width <= 0) return;
      const presentation = stagePresentation[segment.stage];
      const zone = document.createElement("span");
      zone.className = `stage-zone s${segment.stage}`;
      zone.style.left = `${clippedLeft}px`;
      zone.style.width = `${width}px`;
      zone.title = `${presentation.code} ${presentation.title}`;
      backgroundLayer.append(zone);
      if (width >= 28) {
        const label = document.createElement("span");
        label.className = `stage-zone-label s${segment.stage}`;
        label.style.left = `${clippedLeft}px`;
        label.style.width = `${width}px`;
        label.textContent = presentation.code;
        labelLayer.append(label);
      }
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function installDcaBands(container, chart, dcaLine, bands) {
  const backgroundLayer = document.createElement("div");
  backgroundLayer.className = "dca-background-layer";
  container.prepend(backgroundLayer);
  const floor = 0;
  const ceiling = 3;

  const redraw = () => {
    backgroundLayer.replaceChildren();
    (bands || []).forEach((band) => {
      const minimum = band.minimum == null ? floor : Number(band.minimum);
      const maximum = band.maximum == null ? ceiling : Number(band.maximum);
      const topCoordinate = dcaLine.priceToCoordinate(maximum);
      const bottomCoordinate = dcaLine.priceToCoordinate(minimum);
      if (!Number.isFinite(topCoordinate) || !Number.isFinite(bottomCoordinate)) return;
      const top = Math.max(0, Math.min(topCoordinate, bottomCoordinate));
      const bottom = Math.min(container.clientHeight, Math.max(topCoordinate, bottomCoordinate));
      const height = bottom - top;
      if (height <= 0) return;
      const zone = document.createElement("span");
      zone.className = `dca-band-zone ${dcaTierClass(band.amountTier)}`;
      zone.style.top = `${top}px`;
      zone.style.height = `${height}px`;
      backgroundLayer.append(zone);
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(() => requestAnimationFrame(redraw));
  return redraw;
}

function installDcaGuideLabels(container, chart, dcaLine, guides) {
  const labelLayer = document.createElement("div");
  labelLayer.className = "dca-guide-label-layer";
  container.append(labelLayer);

  const redraw = () => {
    labelLayer.replaceChildren();
    const leftScaleWidth = chart.priceScale("left").width?.() || 0;
    guides.forEach((guide) => {
      const y = dcaLine.priceToCoordinate(guide.price);
      if (!Number.isFinite(y)) return;
      const label = document.createElement("span");
      label.className = "dca-guide-label";
      label.textContent = guide.title;
      label.style.left = `${leftScaleWidth + 2}px`;
      label.style.top = `${y}px`;
      label.style.setProperty("--dca-guide-color", guide.color);
      labelLayer.append(label);
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(() => requestAnimationFrame(redraw));
  return redraw;
}

function installDcaSignalTooltips(container, chart, dcaLine, signals, assetCode) {
  const layer = document.createElement("div");
  layer.className = "dca-signal-tooltip-layer";
  const tooltip = document.createElement("div");
  tooltip.className = "dca-signal-tooltip";
  tooltip.setAttribute("role", "status");
  tooltip.setAttribute("aria-live", "polite");
  layer.append(tooltip);
  container.append(layer);
  const signalByDate = new Map((signals || []).map((signal) => [signal.date, signal]));
  let activeSignal = null;
  let activePoint = null;

  const chartTimeToIso = (time) => {
    if (typeof time === "string") return time;
    if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
    if (time && Number.isInteger(time.year) && Number.isInteger(time.month) && Number.isInteger(time.day)) {
      return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
    }
    return "";
  };

  const hide = () => {
    activeSignal = null;
    activePoint = null;
    tooltip.classList.remove("visible");
    tooltip.replaceChildren();
  };

  const redraw = () => {
    if (!activeSignal || !activePoint) return;
    const { x, y } = activePoint;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > container.clientWidth) {
      hide();
      return;
    }
    const tooltipRows = [
      ["日期", fmtDate(activeSignal.date)],
      ["LZ-DCA", fmt(activeSignal.lzDca, 2)],
      ["资产代码", assetCode || "—"],
      ["资产价格", fmt(activeSignal.price, 2)],
      ["类别", activeSignal.label || (activeSignal.type === "high" ? "高位保护点" : "低位关注点")],
    ];
    tooltip.replaceChildren();
    tooltipRows.forEach(([key, value]) => {
      const row = document.createElement("span");
      row.textContent = `${key}：${value}`;
      tooltip.append(row);
    });
    tooltip.classList.add("visible");
    const halfWidth = tooltip.offsetWidth / 2;
    const clampedX = Math.max(halfWidth + 6, Math.min(container.clientWidth - halfWidth - 6, x));
    const showBelow = y < tooltip.offsetHeight + 18;
    tooltip.classList.toggle("below", showBelow);
    tooltip.classList.toggle("above", !showBelow);
    tooltip.style.left = `${clampedX}px`;
    tooltip.style.top = `${y}px`;
  };

  chart.subscribeCrosshairMove?.((param) => {
    const signal = signalByDate.get(chartTimeToIso(param.time));
    if (!signal || !param.point) {
      hide();
      return;
    }
    activeSignal = signal;
    activePoint = { x: param.point.x, y: param.point.y };
    redraw();
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  container.addEventListener("pointerleave", hide);
  return redraw;
}

function installStageTransitions(container, chart, candle, series, history) {
  const layer = document.createElement("div");
  layer.className = "stage-transition-layer";
  container.append(layer);
  const bars = new Map(series.map((bar) => [bar.time || bar.date, bar]));
  const transitions = (history || []).filter((item) => {
    const original = stageNumber(item.originalStage);
    const next = stageNumber(item.newStage);
    return original && next && original !== next && bars.has(item.date);
  });
  const measure = () => transitions.flatMap((item) => {
    const stage = stageNumber(item.newStage);
    const bar = bars.get(item.date);
    const isBelow = stage === 1 || stage === 2;
    const x = chart.timeScale().timeToCoordinate(item.date);
    const y = candle.priceToCoordinate(isBelow ? bar.low : bar.high);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -40 || x > container.clientWidth + 40) return [];
    return [{ item, stage, bar, isBelow, x, y }];
  });
  const draw = (positions) => {
    const badges = positions.map(({ item, stage, bar, isBelow, x, y }) => {
      const badge = document.createElement("span");
      badge.className = `stage-transition-badge s${stage} ${isBelow ? "below" : "above"}`;
      badge.style.left = `${x}px`;
      badge.style.top = `${isBelow ? y + 10 : y - 10}px`;
      badge.tabIndex = 0;
      const originalStage = stageNumber(item.originalStage);
      const presentation = stagePresentation[stage];
      const originalCode = stagePresentation[originalStage]?.code || item.originalStage;
      const label = document.createElement("span");
      label.className = "stage-transition-label";
      label.textContent = `${presentation.arrow} ${presentation.code}`;
      const tooltip = document.createElement("span");
      tooltip.className = "stage-transition-tooltip";
      if (x < 155) tooltip.classList.add("align-left");
      if (x > container.clientWidth - 155) tooltip.classList.add("align-right");
      const tooltipRows = [
        ["日期", item.date],
        ["收盘价", fmt(bar.close, 1)],
        ["阶段转换", `${originalCode} → ${presentation.code} ${presentation.phase}`],
      ];
      tooltipRows.forEach(([key, value]) => {
        const row = document.createElement("span");
        row.textContent = `${key}：${value}`;
        tooltip.append(row);
      });
      badge.setAttribute("aria-label", tooltipRows.map(([key, value]) => `${key}：${value}`).join("；"));
      badge.append(label, tooltip);
      return badge;
    });
    layer.replaceChildren(...badges);
    layer.style.visibility = "visible";
  };
  let markerDrawActive = false;
  let markerDrawPending = false;
  const requestDraw = () => {
    if (!markerDrawActive || markerDrawPending) return;
    markerDrawPending = true;
    requestAnimationFrame(() => {
      markerDrawPending = false;
      if (!layer.isConnected) return;
      draw(measure());
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(requestDraw);
  return () => {
    markerDrawActive = true;
    requestDraw();
  };
}

function bandMarkerPresentation(status) {
  if (/低位金叉|趋势金叉/.test(status)) return { tone: "positive", position: "below", iconLabel: "上三角" };
  if (/上行趋势/.test(status)) return { tone: "uptrend", position: "below", iconLabel: "蓝色圆点" };
  if (/高位保护/.test(status)) return { tone: "protection", position: "above", iconLabel: "橙色下三角" };
  if (/高位死叉|下行风险/.test(status)) return { tone: "risk", position: "above", iconLabel: "下三角" };
  return { tone: "watch", position: "below", iconLabel: "圆点" };
}

function installBandHistoryMarkers(container, chart, candle, series, history) {
  const layer = document.createElement("div");
  layer.className = "band-history-marker-layer";
  container.append(layer);
  const bars = new Map(series.map((bar) => [bar.date || bar.time, bar]));
  const observations = (history || []).filter((item) => bars.has(item.date));
  const redraw = () => {
    layer.replaceChildren();
    observations.forEach((item) => {
      const bar = bars.get(item.date);
      const presentation = bandMarkerPresentation(item.status);
      const isAbove = presentation.position === "above";
      const x = chart.timeScale().timeToCoordinate(item.date);
      const y = candle.priceToCoordinate(isAbove ? bar.high : bar.low);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -24 || x > container.clientWidth + 24) return;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `band-history-marker ${presentation.tone} ${presentation.position}`;
      marker.style.left = `${x}px`;
      marker.style.top = `${isAbove ? y - 9 : y + 9}px`;
      const icon = document.createElement("span");
      icon.className = "band-history-marker-icon";
      icon.setAttribute("aria-hidden", "true");
      const tooltip = document.createElement("span");
      tooltip.className = "band-history-marker-tooltip";
      if (x < 175) tooltip.classList.add("align-left");
      if (x > container.clientWidth - 175) tooltip.classList.add("align-right");
      const tooltipRows = [
        ["状态", item.status],
        ["日期", item.date],
        ["收盘价", fmt(item.price ?? bar.close, 1)],
        ["综合评分", `${fmt(item.fusionScore, 0)} · ${item.fusionStatus || "—"}`],
        ["牛熊分界", `${fmt(item.bullBearScore, 0)} 分`],
        ["趋势红绿灯", `${fmt(item.trafficScore, 0)} 分`],
        ["指标三", `${fmt(item.bandScore, 0)} · ${item.status}`],
        ["状态说明", item.action || "—"],
      ];
      tooltipRows.forEach(([key, value]) => {
        const row = document.createElement("span");
        row.textContent = `${key}：${value}`;
        tooltip.append(row);
      });
      marker.setAttribute("aria-label", `${presentation.iconLabel}；${tooltipRows.map(([key, value]) => `${key}：${value}`).join("；")}`);
      marker.append(icon, tooltip);
      layer.append(marker);
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function installStochRsi(container, chart, series) {
  const panel = document.createElement("div");
  panel.className = "stoch-rsi-panel";
  panel.innerHTML = `
    <div class="stoch-rsi-label"><strong>STOCH RSI</strong><span class="k-line">K</span><span class="d-line">D</span></div>
    <svg class="stoch-rsi-canvas" role="img" aria-label="Stoch RSI 独立坐标轴，范围 0 到 100">
      <rect class="stoch-rsi-zone overbought" data-zone="overbought"></rect>
      <rect class="stoch-rsi-zone oversold" data-zone="oversold"></rect>
      <g class="stoch-rsi-guides"></g>
      <path class="stoch-rsi-line k-line" vector-effect="non-scaling-stroke"></path>
      <path class="stoch-rsi-line d-line" vector-effect="non-scaling-stroke"></path>
      <line class="stoch-rsi-axis-border" vector-effect="non-scaling-stroke"></line>
      <g class="stoch-rsi-axis-values"></g>
      <text class="stoch-rsi-zone-name overbought">超买区</text>
      <text class="stoch-rsi-zone-name oversold">超卖区</text>
    </svg>
  `;
  container.append(panel);

  const svg = panel.querySelector(".stoch-rsi-canvas");
  const kPath = panel.querySelector(".stoch-rsi-line.k-line");
  const dPath = panel.querySelector(".stoch-rsi-line.d-line");
  const guides = panel.querySelector(".stoch-rsi-guides");
  const axisValues = panel.querySelector(".stoch-rsi-axis-values");
  const axisBorder = panel.querySelector(".stoch-rsi-axis-border");
  const overboughtZone = panel.querySelector('[data-zone="overbought"]');
  const oversoldZone = panel.querySelector('[data-zone="oversold"]');
  const overboughtName = panel.querySelector(".stoch-rsi-zone-name.overbought");
  const oversoldName = panel.querySelector(".stoch-rsi-zone-name.oversold");
  const svgNode = (name, attributes = {}) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const yForValue = (value, height) => ((100 - Math.max(0, Math.min(100, Number(value)))) / 100) * height;
  const pathFor = (key, height, plotWidth) => {
    let path = "";
    for (const bar of series) {
      const value = Number(bar[key]);
      const x = chart.timeScale().timeToCoordinate(bar.date || bar.time);
      if (!Number.isFinite(value) || !Number.isFinite(x) || x < -2 || x > plotWidth + 2) continue;
      path += `${path ? " L" : "M"}${x.toFixed(2)} ${yForValue(value, height).toFixed(2)}`;
    }
    return path;
  };
  const redraw = () => {
    const width = panel.clientWidth;
    const height = panel.clientHeight;
    if (!width || !height) return;
    const axisWidth = Math.max(54, Math.ceil(Number(chart.priceScale("right").width?.()) || 68));
    const plotWidth = Math.max(1, width - axisWidth);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    overboughtZone.setAttribute("x", "0");
    overboughtZone.setAttribute("y", "0");
    overboughtZone.setAttribute("width", String(plotWidth));
    overboughtZone.setAttribute("height", String(yForValue(80, height)));
    oversoldZone.setAttribute("x", "0");
    oversoldZone.setAttribute("y", String(yForValue(20, height)));
    oversoldZone.setAttribute("width", String(plotWidth));
    oversoldZone.setAttribute("height", String(height - yForValue(20, height)));
    guides.replaceChildren(...[80, 50, 20].map((value) => svgNode("line", {
      class: `stoch-rsi-guide value-${value}`,
      x1: 0,
      x2: plotWidth,
      y1: yForValue(value, height),
      y2: yForValue(value, height),
      "vector-effect": "non-scaling-stroke",
    })));
    axisValues.replaceChildren(...[80, 50, 20].map((value) => {
      const text = svgNode("text", {
        class: `stoch-rsi-axis-value value-${value}`,
        x: plotWidth + 9,
        y: yForValue(value, height),
        "dominant-baseline": "middle",
      });
      text.textContent = String(value);
      return text;
    }));
    axisBorder.setAttribute("x1", String(plotWidth));
    axisBorder.setAttribute("x2", String(plotWidth));
    axisBorder.setAttribute("y1", "0");
    axisBorder.setAttribute("y2", String(height));
    overboughtName.setAttribute("x", "8");
    overboughtName.setAttribute("y", String(Math.max(10, yForValue(90, height))));
    oversoldName.setAttribute("x", "8");
    oversoldName.setAttribute("y", String(Math.min(height - 3, yForValue(8, height))));
    kPath.setAttribute("d", pathFor("stochK", height, plotWidth));
    dPath.setAttribute("d", pathFor("stochD", height, plotWidth));
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function renderPriceChart(id, series, movingAverages, kind, options = {}) {
  if (state.charts.has(id) || !series?.length) return;
  const container = document.getElementById(id);
  if (!container || container.clientWidth === 0) return;
  const initialChartWidth = container.clientWidth;
  const initialChartHeight = container.clientHeight;
  const api = chartApi(container, kind);
  if (!api) {
    container.innerHTML = '<p class="muted-copy">图表组件未能加载，状态数据仍可正常阅读。</p>';
    return;
  }
  const candle = api.addCandle({ upColor: "#16835d", downColor: "#c94f55", borderVisible: false, wickUpColor: "#16835d", wickDownColor: "#c94f55" });
  candle.setData(series.map((bar) => ({ time: bar.date || bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
  movingAverages.forEach(([key, color, title, lineWidth = 2]) => {
    const showLabel = options.movingAverageLabels !== false;
    const line = api.addLine({
      color,
      lineWidth,
      title: showLabel ? title : "",
      priceLineVisible: false,
      lastValueVisible: showLabel,
    });
    line.setData(series.flatMap((bar) => Number.isFinite(Number(bar[key])) ? [{ time: bar.date || bar.time, value: Number(bar[key]) }] : []));
    if (!showLabel) line.applyOptions({ title: "", priceLineVisible: false, lastValueVisible: false });
  });
  const redrawStochRsi = options.stochRsi ? installStochRsi(container, api.chart, series) : null;
  const applyRequestedVisibleRange = () => {
    if (options.fitAllSeries) {
      api.chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: series.length - 0.5 });
      return;
    }
    if (!options.visibleMonths) return;
    const latestDate = series.at(-1)?.date || series.at(-1)?.time;
    if (latestDate && options.spreadVisibleRange) {
      const firstVisibleDate = shiftIsoMonths(latestDate, -options.visibleMonths);
      const firstVisibleIndex = series.findIndex((bar) => String(bar.date || bar.time) >= firstVisibleDate);
      const from = Math.max(0, firstVisibleIndex < 0 ? 0 : firstVisibleIndex) - 0.5;
      api.chart.timeScale().setVisibleLogicalRange({ from, to: series.length - 0.5 });
    } else if (latestDate) {
      api.chart.timeScale().setVisibleRange({ from: shiftIsoMonths(latestDate, -options.visibleMonths), to: latestDate });
    }
  };
  const recordVisibleRange = (range = api.chart.timeScale().getVisibleLogicalRange?.()) => {
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
    const fromIndex = Math.max(0, Math.min(series.length - 1, Math.ceil(range.from)));
    const toIndex = Math.max(0, Math.min(series.length - 1, Math.floor(range.to)));
    container.dataset.renderedVisibleFrom = series[fromIndex]?.date || series[fromIndex]?.time || "";
    container.dataset.renderedVisibleTo = series[toIndex]?.date || series[toIndex]?.time || "";
    container.dataset.renderedVisibleBars = String(Math.max(0, toIndex - fromIndex + 1));
  };
  api.chart.timeScale().subscribeVisibleLogicalRangeChange?.(recordVisibleRange);
  api.chart.timeScale().fitContent();
  applyRequestedVisibleRange();
  recordVisibleRange();
  const applyZoomBoundary = options.limitZoomToData
    ? installDataZoomBoundary(container, api.chart, series.length)
    : () => {};
  const decorationRedraws = [];
  if (redrawStochRsi) decorationRedraws.push(redrawStochRsi);
  if (options.stageBackground) decorationRedraws.push(installStageBackground(container, api.chart, series));
  if (options.stageTransitions?.length) {
    decorationRedraws.push(installStageTransitions(container, api.chart, candle, series, options.stageTransitions));
  }
  if (options.bandHistory?.length) {
    decorationRedraws.push(installBandHistoryMarkers(container, api.chart, candle, series, options.bandHistory));
  }
  const redrawDecoration = () => decorationRedraws.forEach((redraw) => redraw());
  const redrawAfterChartInteraction = () => {
    requestAnimationFrame(() => requestAnimationFrame(redrawDecoration));
  };
  container.addEventListener("pointermove", (event) => {
    if (event.buttons) redrawAfterChartInteraction();
  }, { capture: true });
  container.addEventListener("wheel", redrawAfterChartInteraction, { capture: true, passive: true });
  container.addEventListener("dblclick", redrawAfterChartInteraction, { capture: true });
  let chartWidth = initialChartWidth;
  let chartHeight = initialChartHeight;
  const observer = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height || (width === chartWidth && height === chartHeight)) return;
    chartWidth = width;
    chartHeight = height;
    api.chart.applyOptions({ width, height });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      applyZoomBoundary();
      applyRequestedVisibleRange();
      recordVisibleRange();
      redrawDecoration();
    }));
  });
  observer.observe(container);
  requestAnimationFrame(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width && height && (width !== chartWidth || height !== chartHeight)) {
      chartWidth = width;
      chartHeight = height;
      api.chart.applyOptions({ width, height });
    }
    requestAnimationFrame(() => {
      applyZoomBoundary();
      applyRequestedVisibleRange();
      recordVisibleRange();
      requestAnimationFrame(redrawDecoration);
    });
  });
  state.charts.set(id, { ...api, candle, observer, redrawDecoration });
}

function renderWeeklyChart() {
  const stagedSeries = seriesWithConfirmedStages(
    (state.weekly?.series || []).filter((bar) => !bar.provisional),
    state.weekly?.stageHistory,
  );
  const completedSeries = trailingSeriesByMonths(stagedSeries, 48);
  const chartElement = document.getElementById("weekly-chart");
  if (chartElement && completedSeries.length) {
    chartElement.dataset.visibleFrom = completedSeries[0].time || completedSeries[0].date;
    chartElement.dataset.visibleTo = completedSeries.at(-1).time || completedSeries.at(-1).date;
    chartElement.dataset.visibleBars = String(completedSeries.length);
  }
  renderPriceChart(
    "weekly-chart",
    completedSeries,
    [["ma10", "#c98632", "MA10", 1], ["ma30", "#2478a5", "MA30", 2]],
    "weekly",
    { stageBackground: true, stageTransitions: state.weekly?.stageHistory, movingAverageLabels: false, fitAllSeries: true, limitZoomToData: true },
  );
}

function renderDailyChart() {
  const series = state.daily?.series || [];
  renderPriceChart(
    "daily-chart",
    series,
    [["ma20", "#a87320", "MA20"], ["ma50", "#2478a5", "MA50"], ["ma200", "#6e5b9e", "MA200"]],
    "daily",
    { bandHistory: state.daily?.bandHistory, movingAverageLabels: false, stochRsi: true, visibleMonths: 4, limitZoomToData: true },
  );
}

function applyDcaTimeRange(chart, series, years = state.dcaRangeYears) {
  const latestDate = series.at(-1)?.date || series.at(-1)?.time;
  if (!chart || !latestDate) return;
  const safeYears = Math.min(4, Math.max(1, Number(years) || 1));
  chart.timeScale().setVisibleRange({ from: shiftIsoMonths(latestDate, -safeYears * 12), to: latestDate });
}

function renderDcaChart() {
  const id = "dca-chart";
  const dca = state.dca;
  const series = dca?.series || [];
  const priceSeries = dca?.priceSeries || [];
  if (state.charts.has(id) || dca?.historyLimited || !series.length || !priceSeries.length) return;
  const container = document.getElementById(id);
  if (!container || container.clientWidth === 0) return;
  const api = chartApi(container, "dca");
  if (!api) {
    container.innerHTML = '<p class="muted-copy">图表组件未能加载，定投建议仍可正常阅读。</p>';
    return;
  }
  const numericPrices = priceSeries.map((bar) => Number(bar.close)).filter(Number.isFinite);
  const priceMinimum = Math.min(...numericPrices);
  const priceMaximum = Math.max(...numericPrices);
  const priceLine = api.addLine({
    priceScaleId: "right",
    color: "#c98632",
    lineWidth: 2,
    title: "",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: true,
    autoscaleInfoProvider: () => ({
      priceRange: { minValue: priceMinimum, maxValue: priceMaximum },
    }),
  });
  priceLine.setData(priceSeries.map((bar) => ({ time: bar.date || bar.time, value: Number(bar.close) })));
  const currentDca = Number(series.at(-1)?.lzDca);
  const dcaAxisValues = [0, 0.5, 1, 2, 3, currentDca].filter(Number.isFinite);
  const dcaAxisFormatter = (value) => {
    const match = dcaAxisValues.find((candidate) => Math.abs(Number(value) - candidate) < 0.005);
    if (match == null) return "";
    if (Math.abs(match - currentDca) < 0.005 && ![0, 0.5, 1, 2, 3].includes(match)) return match.toFixed(2);
    return match === 0 ? "0" : match.toFixed(1);
  };
  const dcaLine = api.addLine({
    priceScaleId: "left",
    color: "#2478a5",
    lineWidth: 2,
    title: "LZ-DCA",
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: "custom", minMove: 0.01, formatter: dcaAxisFormatter },
    autoscaleInfoProvider: () => ({
      priceRange: { minValue: 0, maxValue: 3 },
    }),
  });
  dcaLine.setData(series.map((item) => ({ time: item.date || item.time, value: Number(item.lzDca) })));
  const dcaTemperatureGuides = [
    { price: 0.5, title: "低温线", color: "#2f6fb6" },
    { price: 1, title: "定投线", color: "#16835d" },
    { price: 2, title: "高位线", color: "#c94f55" },
  ];
  const temperatureLines = dcaTemperatureGuides.map(({ price, color }) => dcaLine.createPriceLine({
    price,
    color,
    title: "",
    lineWidth: 1,
    lineStyle: 2,
    lineVisible: true,
    axisLabelVisible: true,
  }));
  const zeroLine = dcaLine.createPriceLine({
    price: 0,
    color: "rgba(110,130,146,.45)",
    lineWidth: 1,
    lineVisible: false,
    axisLabelVisible: true,
    title: "",
  });
  const ceilingLine = dcaLine.createPriceLine({
    price: 3,
    color: "rgba(110,130,146,.45)",
    lineWidth: 1,
    lineVisible: false,
    axisLabelVisible: true,
    title: "",
  });
  const anchors = api.addLine({
    priceScaleId: "left",
    color: "rgba(0,0,0,0)",
    lineWidth: 1,
    lineVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  anchors.setData([
    { time: series[0].date || series[0].time, value: 0 },
    { time: series.at(-1).date || series.at(-1).time, value: 3 },
  ]);
  const dcaDates = new Set(series.map((item) => item.date || item.time));
  const signalMarkers = [...(dca.signals || [])]
    .filter((signal) => dcaDates.has(signal.date))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .map((signal) => ({
      time: signal.date,
      position: "inBar",
      color: signal.type === "high" ? "#c94f55" : "#16835d",
      shape: "circle",
      text: "",
      size: 0.8,
    }));
  dcaLine.setMarkers?.(signalMarkers);
  api.chart.priceScale("left").applyOptions({
    visible: true,
    borderColor: "rgba(16,40,59,.12)",
    scaleMargins: { top: 0.03, bottom: 0.03 },
  });
  api.chart.priceScale("right").applyOptions({
    visible: true,
    borderColor: "rgba(16,40,59,.12)",
    scaleMargins: { top: 0.03, bottom: 0.03 },
  });
  api.chart.timeScale().fitContent();
  applyDcaTimeRange(api.chart, series);
  const redrawBands = installDcaBands(container, api.chart, dcaLine, dca.bands);
  const redrawGuideLabels = installDcaGuideLabels(container, api.chart, dcaLine, dcaTemperatureGuides);
  const asset = assets[state.assetId] || {};
  const assetCurrency = state.current?.quote?.currency || asset.currency || "";
  const assetCode = [asset.code, assetCurrency].filter(Boolean).join("/");
  const redrawSignalTooltips = installDcaSignalTooltips(container, api.chart, dcaLine, dca.signals, assetCode);
  const redrawDecoration = () => {
    redrawBands();
    redrawGuideLabels();
    redrawSignalTooltips();
  };
  const redrawAfterInteraction = () => requestAnimationFrame(() => requestAnimationFrame(redrawDecoration));
  container.addEventListener("pointermove", (event) => { if (event.buttons) redrawAfterInteraction(); }, { capture: true });
  container.addEventListener("wheel", redrawAfterInteraction, { capture: true, passive: true });
  container.addEventListener("dblclick", redrawAfterInteraction, { capture: true });
  const observer = new ResizeObserver(() => {
    api.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    redrawAfterInteraction();
  });
  observer.observe(container);
  state.charts.set(id, {
    ...api,
    priceLine,
    dcaLine,
    anchors,
    temperatureLines,
    zeroLine,
    ceilingLine,
    signalMarkers,
    observer,
    redrawDecoration,
  });
}

async function loadAsset(assetId, { historyMode = "none", targetRoute = routeFromLocation() } = {}) {
  if (!assets[assetId]) return;
  const route = (isLegacyMacroObservation(assetId) && !["overview", "methodology"].includes(targetRoute)) || (isMacroAsset(assetId) && targetRoute === "dca")
    ? "overview" : routes.has(targetRoute) ? targetRoute : "overview";
  if (!requestAssetAccess(assetId, route)) return;
  if (historyMode === "push") history.pushState({ assetId, route }, "", routePath(route, assetId));
  if (historyMode === "replace") history.replaceState({ assetId, route }, "", routePath(route, assetId));
  syncPageMode();
  const token = state.loadToken + 1;
  state.loadToken = token;
  state.assetId = assetId;
  state.current = null;
  state.daily = null;
  state.weekly = null;
  state.dca = null;
  state.fundamentals = null;
  state.news = null;
  state.routeLoads.clear();
  clearCharts();
  updateRouteLinks();
  renderWatchlist();
  $("#loading-state").hidden = false;
  $("#error-state").hidden = true;
  try {
    const current = await loadAssetResource(assetId, "current.json");
    if (token !== state.loadToken || assetId !== state.assetId) return;
    updateAssetPresentationFromSnapshot(assetId, current);
    state.current = current;
    state.assetSummaries.set(assetId, current);
    updateHeader();
    renderWatchlist();
    const macro = current.schemaVersion === "macro-observation-v1";
    $("#standard-overview").hidden = macro;
    $("#quality-banner").hidden = macro;
    $("#macro-overview").hidden = !macro;
    if (macro) {
      state.daily = await loadAssetResource(assetId, "daily-series.json");
      if (token !== state.loadToken || assetId !== state.assetId) return;
      renderMacroOverview();
    } else renderOverview();
    renderMethodology();
    $("#loading-state").hidden = true;
    activateRoute();
  } catch (error) {
    if (token !== state.loadToken) return;
    $("#loading-state").hidden = true;
    $("#error-state").hidden = false;
    $("#error-message").textContent = error.message || "请稍后重试。";
    console.error(error);
  }
}

async function resetMemberUiAfterSessionEnd() {
  finishWatchlistDrag();
  state.memberProfile = null;
  state.memberAssets = [];
  state.assetSummaries = new Map();
  state.memberJobs = [];
  state.watchlistSorting = false;
  state.watchlistCategory = "all";
  state.watchlistOrderBeforeEdit = [];
  state.watchlistOrderSaving = false;
  if (state.assetPollTimer) window.clearTimeout(state.assetPollTimer);
  state.authReady = true;
  closeMemberDialog();
  renderMemberControls();
  renderWatchlist();
  normalizeRoute();
}

async function handleMemberLogout() {
  await signOutMember().catch(() => undefined);
  await resetMemberUiAfterSessionEnd();
}

async function handleMemberLogin(event) {
  event.preventDefault();
  const submit = $("#member-login-submit");
  const errorNode = $("#member-login-error");
  submit.dataset.loading = "true";
  submit.disabled = true;
  submit.textContent = "正在登录…";
  errorNode.hidden = true;
  try {
    const profile = await signInMember(
      $("#member-email").value,
      $("#member-password").value,
      memberCaptchaToken,
    );
    const pendingAssetId = state.pendingAssetId;
    const pendingRoute = state.pendingRoute;
    state.memberProfile = profile;
    state.authReady = true;
    await refreshMemberLibrary({ quiet: true });
    renderMemberControls();
    renderWatchlist();
    closeMemberDialog({ preservePending: true });
    state.pendingAssetId = null;
    state.pendingRoute = "overview";
    if (pendingAssetId) {
      if (pendingRoute === "dca" && !canUseDca()) {
        window.alert("当前账号未开通定投指标。需要开通时请联系管理员。");
        await loadAsset(pendingAssetId, { historyMode: "push", targetRoute: "overview" });
      } else {
        await loadAsset(pendingAssetId, { historyMode: "push", targetRoute: pendingRoute });
      }
    } else {
      const route = normalizeRoute({ preferFirstAsset: true });
      renderWatchlist();
      if (route && !state.watchlistView) await loadAsset(state.assetId, { historyMode: "replace", targetRoute: route });
    }
  } catch (error) {
    errorNode.textContent = memberErrorMessage(error);
    errorNode.hidden = false;
    $("#member-password").value = "";
    memberCaptchaToken = "";
    if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
  } finally {
    submit.dataset.loading = "false";
    syncMemberSubmit();
  }
}

async function handleDisplayNameUpdate(event) {
  event.preventDefault();
  const submit = $("#display-name-submit");
  submit.dataset.loading = "true";
  submit.disabled = true;
  submit.textContent = "正在保存…";
  setAccountFeedback("#display-name-feedback");
  try {
    state.memberProfile = await updateMemberDisplayName($("#account-display-name").value);
    renderMemberControls();
    $("#member-dialog-name").textContent = state.memberProfile.display_name || "会员";
    $("#account-display-name").value = state.memberProfile.display_name || "";
    setAccountFeedback("#display-name-feedback", "用户名已更新。", "success");
  } catch (error) {
    setAccountFeedback("#display-name-feedback", memberErrorMessage(error), "error");
  } finally {
    submit.dataset.loading = "false";
    submit.disabled = false;
    submit.textContent = "保存用户名";
  }
}

async function handlePasswordUpdate(event) {
  event.preventDefault();
  const submit = $("#password-submit");
  const currentPassword = $("#account-current-password").value;
  const newPassword = $("#account-new-password").value;
  const confirmPassword = $("#account-confirm-password").value;
  if (newPassword !== confirmPassword) {
    setAccountFeedback("#password-feedback", "两次输入的新密码不一致。", "error");
    return;
  }
  submit.dataset.loading = "true";
  submit.disabled = true;
  submit.textContent = "正在修改…";
  setAccountFeedback("#password-feedback");
  try {
    await updateMemberPassword(currentPassword, newPassword, accountCaptchaToken);
    $("#account-current-password").value = "";
    $("#account-new-password").value = "";
    $("#account-confirm-password").value = "";
    setAccountFeedback("#password-feedback", "密码已修改，下次登录请使用新密码。", "success");
    await renderAccountTurnstileWidget();
  } catch (error) {
    setAccountFeedback("#password-feedback", memberErrorMessage(error), "error");
    await renderAccountTurnstileWidget();
  } finally {
    submit.dataset.loading = "false";
    submit.textContent = "确认修改密码";
    syncAccountPasswordSubmit();
  }
}

async function boot() {
  renderMemberControls();
  renderWatchlist();
  state.memberProfile = await restoreMemberSession();
  state.authReady = true;
  renderMemberControls();
  if (isMember()) await refreshMemberLibrary({ quiet: true });
  const launchInWatchlist = mobileLayout.matches && isStandaloneApp()
    && (isRootEntry() || locationContext().view === "watchlist");
  const route = normalizeRoute({
    preferFirstAsset: !launchInWatchlist,
    preferWatchlist: launchInWatchlist,
  });
  renderWatchlist();
  if (!route) return;
  if (state.watchlistView) {
    activateRoute();
    return;
  }
  if (route === "methodology") {
    renderMethodology();
    activateRoute();
  }
  await loadAsset(state.assetId);
  if (state.pendingAssetId) openMemberLogin(state.pendingAssetId, state.pendingRoute);
  if (state.pendingDcaNotice) {
    state.pendingDcaNotice = false;
    window.alert("当前账号未开通定投指标。需要开通时请联系管理员。");
  }
}

lockMobilePageZoom();
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-watchlist-theme-toggle]")) {
    event.preventDefault();
    toggleWatchlistTheme();
    return;
  }
  if (event.target.closest("#member-login-button")) {
    event.preventDefault();
    openMemberLogin();
    return;
  }
  if (event.target.closest("[data-member-action]")) {
    event.preventDefault();
    if (isMember()) openMemberAccount();
    else openMemberLogin();
    return;
  }
  if (event.target.closest("#member-account-button")) {
    event.preventDefault();
    openMemberAccount();
    return;
  }
  if (event.target.closest("#member-logout-button, #member-dialog-logout")) {
    event.preventDefault();
    void handleMemberLogout();
    return;
  }
  if (event.target.closest("[data-close-member-dialog]")) {
    event.preventDefault();
    closeMemberDialog();
    return;
  }
  const addButton = event.target.closest("#add-asset-button");
  if (addButton) {
    event.preventDefault();
    if (readWatchlist().length >= 30) {
      window.alert("个人资产已达到 30 个上限，请先移除一个资产。");
      return;
    }
    renderWatchlist();
    setAssetPicker(true);
    return;
  }
  if (event.target.closest("#watchlist-sort-button")) {
    event.preventDefault();
    void toggleWatchlistSorting();
    return;
  }
  if (event.target.closest("[data-close-asset-picker]")) {
    event.preventDefault();
    setAssetPicker(false);
    return;
  }
  const addAsset = event.target.closest("[data-add-result]");
  if (addAsset) {
    event.preventDefault();
    void handleAddAsset(Number(addAsset.dataset.addResult));
    return;
  }
  const removeAsset = event.target.closest("[data-remove-asset]");
  if (removeAsset) {
    event.preventDefault();
    event.stopPropagation();
    void handleRemoveAsset(removeAsset.dataset.removeAsset);
    return;
  }
  const assetButton = event.target.closest(".watchlist-asset[data-asset]");
  if (assetButton) {
    event.preventDefault();
    if (state.watchlistSorting) return;
    const assetId = assetButton.dataset.asset;
    const status = assetButton.dataset.status;
    if (status !== "ready") {
      const row = memberAssetRow(assetId);
      const job = state.memberJobs.find((item) => item.asset_id === assetId);
      window.alert(status === "failed"
        ? `${row?.asset?.name || "该资产"}初始化失败：${initializationFailureMessage(job)}`
        : `${row?.asset?.name || "该资产"}${initializationStageLabel(job?.progress_stage)}，完成后即可打开。`);
      return;
    }
    const fromWatchlist = state.watchlistView;
    if (fromWatchlist) state.watchlistScrollY = window.scrollY;
    const currentRoute = routeFromLocation();
    const targetRoute = fromWatchlist || currentRoute === "methodology" ? "overview" : currentRoute;
    const needsAssetLoad = assetId !== state.assetId || targetRoute !== currentRoute || !state.current;
    if (needsAssetLoad) {
      void loadAsset(assetId, { historyMode: "push", targetRoute });
    } else if (fromWatchlist) {
      history.pushState({ assetId, route: targetRoute }, "", routePath(targetRoute, assetId));
      syncPageMode();
      activateRoute();
    }
    return;
  }
  const retry = event.target.closest("[data-retry-route]");
  if (retry) {
    event.preventDefault();
    void ensureRouteData(retry.dataset.retryRoute, { force: true });
    return;
  }
  const watchlistLink = event.target.closest("[data-watchlist-link]");
  if (watchlistLink) {
    event.preventDefault();
    if (location.pathname !== watchlistPath()) history.pushState({ view: "watchlist" }, "", watchlistPath());
    syncPageMode();
    activateRoute();
    return;
  }
  const link = event.target.closest("[data-route]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (!state.assetId) {
    if (location.pathname !== watchlistPath()) history.replaceState({ view: "watchlist" }, "", watchlistPath());
    syncPageMode();
    renderWatchlist();
    return;
  }
  const route = routes.has(link.dataset.route) ? link.dataset.route : "overview";
  if (route === "dca" && !canUseDca()) {
    if (isMember()) window.alert("当前账号未开通定投指标。需要开通时请联系管理员。");
    else openMemberLogin(state.assetId, "dca");
    return;
  }
  if (location.pathname !== routePath(route)) history.pushState({ assetId: state.assetId, route }, "", routePath(route));
  syncPageMode();
  activateRoute();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#asset-picker").hidden) setAssetPicker(false);
  if (event.key === "Escape" && !$("#member-dialog").hidden) closeMemberDialog();
});
document.addEventListener("visibilitychange", refreshMemberLibraryOnResume);
window.addEventListener("pageshow", refreshMemberLibraryOnResume);
window.addEventListener("focus", refreshMemberLibraryOnResume);
window.addEventListener("online", refreshMemberLibraryOnResume);
window.setInterval(heartbeatMemberDeviceSession, 60_000);
window.addEventListener("popstate", () => {
  let context = locationContext();
  const firstAssetId = firstAccessibleAssetId();
  if (!firstAssetId) {
    normalizeRoute();
    renderWatchlist();
    return;
  }
  if (context.view === "watchlist" && mobileLayout.matches) {
    syncPageMode();
    renderWatchlist();
    restoreWatchlistScroll();
    return;
  }
  syncPageMode();
  if (!canAccessAsset(context.assetId)) {
    const fallbackRoute = context.route === "methodology" ? context.route : "overview";
    history.replaceState({ assetId: firstAssetId, route: fallbackRoute }, "", routePath(fallbackRoute, firstAssetId));
    context = { assetId: firstAssetId, route: fallbackRoute };
  }
  if (context.route === "dca" && !canUseDca(context.assetId)) {
    const blockedAssetId = context.assetId;
    history.replaceState({ assetId: blockedAssetId, route: "overview" }, "", routePath("overview", blockedAssetId));
    if (isMember()) window.alert("当前账号未开通定投指标。需要开通时请联系管理员。");
    else openMemberLogin(blockedAssetId, "dca");
    context = { assetId: blockedAssetId, route: "overview" };
  }
  if (context.assetId !== state.assetId) {
    void loadAsset(context.assetId, { targetRoute: context.route });
  } else {
    activateRoute();
  }
});
mobileLayout.addEventListener?.("change", () => {
  if (!firstAccessibleAssetId()) {
    normalizeRoute();
    renderWatchlist();
    return;
  }
  const context = locationContext();
  if (!mobileLayout.matches && context.view === "watchlist") {
    const route = "overview";
    history.replaceState({ assetId: state.assetId, route }, "", routePath(route));
  }
  syncPageMode();
  activateRoute();
  if (state.fundamentals && routeFromLocation() === "fundamentals") renderFundamentals();
});

$("#member-login-form").addEventListener("submit", handleMemberLogin);
$("#member-login-form").addEventListener("input", syncMemberSubmit);
$("#member-display-name-form").addEventListener("submit", handleDisplayNameUpdate);
$("#member-password-form").addEventListener("submit", handlePasswordUpdate);
$("#member-password-form").addEventListener("input", syncAccountPasswordSubmit);
$("#asset-search-form").addEventListener("submit", handleAssetSearch);
$("#asset-category").addEventListener("change", (event) => {
  const macro = event.target.value === "macro";
  $("#asset-query").placeholder = macro ? "US10Y / DXY" : "AAPL / 600519 / 0700 / ETH / GC";
  $("#asset-query").value = "";
  state.assetSearchResults = [];
  setAssetPickerMessage(macro ? "宏观分类可添加 US10Y 或 DXY。" : "请输入对应分类的资产代码。");
  renderAssetSearchResults();
});
$("#watchlist-category-filter").addEventListener("change", (event) => {
  const category = String(event.target.value || "all");
  state.watchlistCategory = WATCHLIST_CATEGORIES.has(category) ? category : "all";
  renderWatchlist();
});
$("#asset-watchlist").addEventListener("pointerdown", handleWatchlistPointerDown);
$("#asset-watchlist").addEventListener("pointermove", handleWatchlistPointerMove);
$("#asset-watchlist").addEventListener("pointerup", handleWatchlistPointerUp);
$("#asset-watchlist").addEventListener("pointercancel", handleWatchlistPointerUp);
$("#asset-watchlist").addEventListener("keydown", handleWatchlistKeydown);
$("#dca-range-select").addEventListener("change", (event) => {
  state.dcaRangeYears = Math.min(4, Math.max(1, Number(event.target.value) || 1));
  if (state.dca) renderDcaZoneStatistics(state.dca, state.dcaRangeYears);
  const chartEntry = state.charts.get("dca-chart");
  if (!chartEntry || !state.dca?.series?.length) return;
  applyDcaTimeRange(chartEntry.chart, state.dca.series, state.dcaRangeYears);
  requestAnimationFrame(() => requestAnimationFrame(chartEntry.redrawDecoration));
});

if ("serviceWorker" in navigator) {
  const localPreview = ["127.0.0.1", "localhost"].includes(location.hostname);
  window.addEventListener("load", async () => {
    if (localPreview) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      return;
    }
    navigator.serviceWorker
      .register(new URL("service-worker.js?v=1.3.44", SITE_ROOT), { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(console.warn);
  });
}

applyWatchlistTheme(document.documentElement.dataset.watchlistTheme);
syncPageMode();
boot().catch((error) => console.error(error)).finally(dismissAppSplash);
