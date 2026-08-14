const DEFAULT_LOCALE = "en-US";

export const getUserLocale = () => {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return navigator.language || DEFAULT_LOCALE;
};

const getFormatter = (factory, fallbackFactory) => {
  try {
    return factory(getUserLocale());
  } catch {
    return fallbackFactory(DEFAULT_LOCALE);
  }
};

export const toFiniteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const formatNumber = (value, options = {}) => {
  const parsed = toFiniteNumber(value, 0);
  return getFormatter(
    (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...options }),
    (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...options }),
  ).format(parsed);
};

export const formatCurrency = (value, currency = "USD") => {
  const parsed = toFiniteNumber(value, 0);
  return getFormatter(
    (locale) => new Intl.NumberFormat(locale, {
      currency,
      maximumFractionDigits: 2,
      style: "currency",
    }),
    (locale) => new Intl.NumberFormat(locale, {
      currency,
      maximumFractionDigits: 2,
      style: "currency",
    }),
  ).format(parsed);
};

export const formatPercent = (value) => {
  const parsed = toFiniteNumber(value, 0);
  return getFormatter(
    (locale) => new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    }),
    (locale) => new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    }),
  ).format(parsed) + "%";
};

export const formatLatency = (value) => {
  const parsed = toFiniteNumber(value, null);
  if (parsed === null) return "N/A";
  return `${formatNumber(parsed, { maximumFractionDigits: 0 })} ms`;
};

const getValidDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatShortDate = (value) => {
  const date = getValidDate(value);
  if (!date) return "";
  return getFormatter(
    (locale) => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" }),
    (locale) => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" }),
  ).format(date);
};

export const formatMonthYear = (value) => {
  const date = getValidDate(value);
  if (!date) return "";
  return getFormatter(
    (locale) => new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }),
    (locale) => new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }),
  ).format(date);
};

export const formatTime = (value) => {
  const date = getValidDate(value);
  if (!date) return "";
  return getFormatter(
    (locale) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    (locale) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  ).format(date);
};
