import { create } from "zustand";
import { getApiErrorMessage, getSemanticModelsByConnection } from "../api/services";

const CATALOG_CACHE_VERSION = 1;
const CATALOG_CACHE_TTL_MS = 5 * 60_000;
const INVALIDATING_STATUSES = new Set([400, 401, 403, 404, 409]);

const cacheKey = (connectionId) => `anonymous_ai_catalog_cache_${connectionId}`;

const readCachedCatalog = (connectionId) => {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKey(connectionId));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    const isValid =
      cached?.version === CATALOG_CACHE_VERSION &&
      String(cached?.connectionId) === String(connectionId) &&
      Array.isArray(cached?.datasets) &&
      Date.now() - Number(cached?.fetchedAt || 0) < CATALOG_CACHE_TTL_MS;
    return isValid ? cached : null;
  } catch {
    return null;
  }
};

const writeCachedCatalog = (connectionId, datasets, fetchedAt) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    cacheKey(connectionId),
    JSON.stringify({
      version: CATALOG_CACHE_VERSION,
      connectionId: String(connectionId),
      fetchedAt,
      datasets,
    }),
  );
};

const removeCachedCatalog = (connectionId) => {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(cacheKey(connectionId));
};

export const useCatalogStore = create((set, get) => ({
  byConnection: {},
  errorByConnection: {},
  loadingByConnection: {},
  pendingByConnection: {},
  async load(connectionId, options = {}) {
    if (!connectionId) return;
    const force = options.force === true;
    const state = get();
    if (!force && state.byConnection[connectionId] && Date.now() - state.byConnection[connectionId].fetchedAt < CATALOG_CACHE_TTL_MS) return;
    if (!force) {
      const cached = readCachedCatalog(connectionId);
      if (cached) {
        set((s) => ({
          byConnection: { ...s.byConnection, [connectionId]: { datasets: cached.datasets, fetchedAt: cached.fetchedAt } },
          errorByConnection: { ...s.errorByConnection, [connectionId]: null },
          loadingByConnection: { ...s.loadingByConnection, [connectionId]: false },
        }));
        return;
      }
    }
    if (state.pendingByConnection[connectionId]) return state.pendingByConnection[connectionId];

    const request = getSemanticModelsByConnection(connectionId);
    set((s) => ({
      errorByConnection: { ...s.errorByConnection, [connectionId]: null },
      loadingByConnection: { ...s.loadingByConnection, [connectionId]: true },
    }));
    try {
      set((s) => ({ pendingByConnection: { ...s.pendingByConnection, [connectionId]: request } }));
      const data = await request;
      const datasets = data.ai_catalog?.datasets ?? [];
      const fetchedAt = Date.now();
      writeCachedCatalog(connectionId, datasets, fetchedAt);
      set((s) => ({
        byConnection: { ...s.byConnection, [connectionId]: { datasets, fetchedAt } },
        errorByConnection: { ...s.errorByConnection, [connectionId]: null },
        loadingByConnection: { ...s.loadingByConnection, [connectionId]: false },
      }));
    } catch (error) {
      if (INVALIDATING_STATUSES.has(error?.status || error?.response?.status)) {
        removeCachedCatalog(connectionId);
      }
      set((s) => ({
        errorByConnection: {
          ...s.errorByConnection,
          [connectionId]: getApiErrorMessage(error, "Failed to load semantic catalog"),
        },
        loadingByConnection: { ...s.loadingByConnection, [connectionId]: false },
      }));
    } finally {
      set((s) => {
        const next = { ...s.pendingByConnection };
        delete next[connectionId];
        return { pendingByConnection: next };
      });
    }
  },
  refresh(connectionId) {
    removeCachedCatalog(connectionId);
    return get().load(connectionId, { force: true });
  },
  invalidate(connectionId) {
    set((s) => {
      const next = { ...s.byConnection };
      const errors = { ...s.errorByConnection };
      const pending = { ...s.pendingByConnection };
      delete next[connectionId];
      delete errors[connectionId];
      delete pending[connectionId];
      removeCachedCatalog(connectionId);
      return { byConnection: next, errorByConnection: errors, pendingByConnection: pending };
    });
  },
}));
