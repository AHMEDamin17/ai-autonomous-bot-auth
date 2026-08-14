/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect } from "react";
import defaultTheme from "../config/theme.json";

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("app-theme");
      return saved ? JSON.parse(saved) : defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  const updateTheme = (newThemeConfig) => {
    setTheme((prevTheme) => ({ ...prevTheme, ...newThemeConfig }));
  };

  const saveTheme = () => {
    setTheme((currentTheme) => {
      localStorage.setItem("app-theme", JSON.stringify(currentTheme));
      return currentTheme;
    });
  };

  const resetTheme = () => {
    localStorage.removeItem("app-theme");
    setTheme(defaultTheme);
  };

  useEffect(() => {
    const root = document.documentElement;

    if (theme.colors) {
      if (theme.colors.primary) root.style.setProperty("--theme-primary", theme.colors.primary);
      if (theme.colors.primaryHover) root.style.setProperty("--theme-primary-hover", theme.colors.primaryHover);
      if (theme.colors.primaryActive) root.style.setProperty("--theme-primary-active", theme.colors.primaryActive);
      if (theme.colors.primaryDisabled) root.style.setProperty("--theme-primary-disabled", theme.colors.primaryDisabled);

      if (theme.colors.background) {
        root.style.setProperty("--theme-background", theme.colors.background);
        root.style.setProperty("--theme-theme-background", theme.colors.background);
      }
      if (theme.colors.surface) root.style.setProperty("--theme-surface", theme.colors.surface);
      if (theme.colors.text) root.style.setProperty("--theme-text", theme.colors.text);
      if (theme.colors.textSecondary) root.style.setProperty("--theme-text-secondary", theme.colors.textSecondary);
      if (theme.colors.textMuted) root.style.setProperty("--theme-text-muted", theme.colors.textMuted);

      if (theme.colors.border) root.style.setProperty("--theme-border", theme.colors.border);
      if (theme.colors.borderDark) root.style.setProperty("--theme-border-dark", theme.colors.borderDark);
      if (theme.colors.borderBlack) root.style.setProperty("--theme-border-black", theme.colors.borderBlack);

      if (theme.colors.accent) root.style.setProperty("--theme-accent", theme.colors.accent);
      if (theme.colors.accentDisabled) root.style.setProperty("--theme-accent-disabled", theme.colors.accentDisabled);

      if (theme.colors.containerBg) root.style.setProperty("--theme-container-bg", theme.colors.containerBg);
      if (theme.colors.cardBg) root.style.setProperty("--theme-card-bg", theme.colors.cardBg);
      if (theme.colors.cardBorderColor) root.style.setProperty("--theme-card-border", theme.colors.cardBorderColor);

      if (theme.colors.sidebarBtnColor) root.style.setProperty("--theme-sidebar-btn-color", theme.colors.sidebarBtnColor);
      if (theme.colors.sidebarBtnHoverBg) root.style.setProperty("--theme-sidebar-btn-hover", theme.colors.sidebarBtnHoverBg);

      if (theme.colors.scrollbarTrack) root.style.setProperty("--theme-scroll-track", theme.colors.scrollbarTrack);
      if (theme.colors.scrollbarThumb) root.style.setProperty("--theme-scroll-thumb", theme.colors.scrollbarThumb);
      if (theme.colors.scrollbarThumbHover) root.style.setProperty("--theme-scroll-thumb-hover", theme.colors.scrollbarThumbHover);

      if (theme.colors.chipBg) root.style.setProperty("--theme-chip-bg", theme.colors.chipBg);
      if (theme.colors.chipBorder) root.style.setProperty("--theme-chip-border", theme.colors.chipBorder);
      if (theme.colors.chipText) root.style.setProperty("--theme-chip-text", theme.colors.chipText);
      if (theme.colors.chipHoverBg) root.style.setProperty("--theme-chip-hover-bg", theme.colors.chipHoverBg);

      if (theme.colors.gradientStart) root.style.setProperty("--theme-gradient-start", theme.colors.gradientStart);
      if (theme.colors.gradientEnd) root.style.setProperty("--theme-gradient-end", theme.colors.gradientEnd);
      if (theme.colors.bgGradientStart) root.style.setProperty("--theme-bg-grad-start", theme.colors.bgGradientStart);
      if (theme.colors.bgGradientEnd) root.style.setProperty("--theme-bg-grad-end", theme.colors.bgGradientEnd);
    }

    if (theme.fonts) {
      if (theme.fonts.main) root.style.setProperty("--theme-font-main", theme.fonts.main);
    }

    if (theme.borders) {
      if (theme.borders.radiusButton) root.style.setProperty("--theme-radius-btn", theme.borders.radiusButton);
      if (theme.borders.radiusCard) root.style.setProperty("--theme-radius-card", theme.borders.radiusCard);
      if (theme.borders.radiusChip) root.style.setProperty("--theme-radius-chip", theme.borders.radiusChip);
      if (theme.borders.radiusIconCircle) root.style.setProperty("--theme-radius-icon-circle", theme.borders.radiusIconCircle);
    }

    if (theme.components) {
      if (theme.components.cardShadow) root.style.setProperty("--theme-card-shadow", theme.components.cardShadow);
      if (theme.components.cardHoverShadow) root.style.setProperty("--theme-card-hover-shadow", theme.components.cardHoverShadow);
      if (theme.components.buttonShadow) root.style.setProperty("--theme-btn-shadow", theme.components.buttonShadow);
      if (theme.components.chipShadow) root.style.setProperty("--theme-chip-shadow", theme.components.chipShadow);
      if (theme.components.chatContainerBg) root.style.setProperty("--theme-chat-bg", theme.components.chatContainerBg);
      if (theme.components.chatContainerBorder) root.style.setProperty("--theme-chat-border", theme.components.chatContainerBorder);
      if (theme.components.inputBg) root.style.setProperty("--theme-input-bg", theme.components.inputBg);
      if (theme.components.inputBorder) root.style.setProperty("--theme-input-border", theme.components.inputBorder);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, updateTheme, saveTheme, resetTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};
