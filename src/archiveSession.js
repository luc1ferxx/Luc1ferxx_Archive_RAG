const SESSION_STORAGE_KEY = "archive-session-id";
const USER_STORAGE_KEY = "archive-user-id";

const createStableId = (prefix) =>
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : null) ??
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const createSessionId = () => createStableId("session");

const createUserId = () => createStableId("user");

const readStoredId = (storageKey, fallbackFactory) => {
  try {
    const storedValue = window.localStorage.getItem(storageKey);
    return storedValue?.trim() ? storedValue : fallbackFactory();
  } catch {
    return fallbackFactory();
  }
};

const persistStoredId = (storageKey, value) => {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // Ignore localStorage failures for browsers with restricted storage access.
  }
};

export const readStoredSessionId = () =>
  readStoredId(SESSION_STORAGE_KEY, createSessionId);

export const readStoredUserId = () => readStoredId(USER_STORAGE_KEY, createUserId);

export const persistSessionId = (sessionId) =>
  persistStoredId(SESSION_STORAGE_KEY, sessionId);

export const persistUserId = (userId) => persistStoredId(USER_STORAGE_KEY, userId);
