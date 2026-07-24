export function formatTokens(tokens: number): string {
    return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens)
}

export function percent(value: number, total: number): number {
    if (!Number.isFinite(total) || total <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

// A fixed-width meter. Returns the filled and empty runs separately so callers
// can colour them independently through pi's theme.
export function meter(
    value: number,
    total: number,
    width: number,
): { filled: string; empty: string; percent: number } {
    const pct = percent(value, total)
    const filled = total > 0 ? Math.round((pct / 100) * width) : 0
    return {
        filled: "█".repeat(filled),
        empty: "░".repeat(Math.max(0, width - filled)),
        percent: pct,
    }
}

export function padEnd(text: string, width: number): string {
    return text.length >= width ? text : text + " ".repeat(width - text.length)
}
