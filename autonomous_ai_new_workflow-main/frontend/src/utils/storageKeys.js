const APP_STORAGE_PREFIX = "anonymous_ai";

export const queryHistoryStorageKey = (connectionId) => (
  `${APP_STORAGE_PREFIX}_query_history_${connectionId}`
);

export const legacyQueryHistoryStorageKey = (connectionId) => (
  `query_history_${connectionId}`
);
