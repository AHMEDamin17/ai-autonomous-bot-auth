const TYPE_STYLES = {
  empty: "border-(--theme-border) bg-(--theme-container-bg) text-(--theme-text-muted)",
  // Semantic (error = red) is intentional regardless of theme; only the neutral parts route through theme tokens.
  error: "border-red-200 bg-red-50 text-red-700",
  loading: "border-(--theme-border) bg-(--theme-surface) text-(--theme-text-muted)",
};

export default function InlineState({
  actionLabel,
  className = "",
  message,
  onAction,
  title,
  type = "empty",
}) {
  const styles = TYPE_STYLES[type] || TYPE_STYLES.empty;

  return (
    <div className={`rounded-xl border px-4 py-6 text-center ${styles} ${className}`}>
      {type === "loading" && (
        <div className="mx-auto mb-3 h-5 w-5 rounded-full border-2 border-(--theme-border) border-t-(--theme-primary) animate-spin" />
      )}
      {title && <p className="text-sm font-bold">{title}</p>}
      {message && <p className="mt-1 text-xs font-medium opacity-80">{message}</p>}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 rounded-lg border border-current px-3 py-1.5 text-xs font-bold hover:bg-(--theme-surface)/60 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
