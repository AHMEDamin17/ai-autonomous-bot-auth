const isUnsafeControlChar = (char) => {
  const code = char.charCodeAt(0);
  return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
};

export const toSafeText = (value, fallback = "") => {
  if (value === null || value === undefined) return fallback;
  try {
    return String(value)
      .split("")
      .filter((char) => !isUnsafeControlChar(char))
      .join("");
  } catch {
    return fallback;
  }
};

export const toSafeTextList = (items) => (
  Array.isArray(items) ? items.map((item) => toSafeText(item)).filter(Boolean) : []
);

export const toSafeJson = (value, fallback = "{}") => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
};
