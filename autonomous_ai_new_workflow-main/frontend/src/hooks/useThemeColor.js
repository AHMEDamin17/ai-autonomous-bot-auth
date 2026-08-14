import { useEffect, useState } from "react";

const readThemeColor = (name, fallback) => {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim() || fallback;
};

export function useThemeColor(name, fallback) {
  const [color, setColor] = useState(() => readThemeColor(name, fallback));

  useEffect(() => {
    if (typeof document === "undefined") return;

    const refresh = () => setColor(readThemeColor(name, fallback));
    refresh();

    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    window.addEventListener("storage", refresh);

    return () => {
      observer.disconnect();
      window.removeEventListener("storage", refresh);
    };
  }, [fallback, name]);

  return color;
}
