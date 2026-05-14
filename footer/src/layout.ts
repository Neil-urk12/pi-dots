import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Public interface ──────────────────────────────────────────

/**
 * Two-sided footer layout: joins left and right string arrays with a
 * separator, then pads or truncates the result to fit `width`.
 *
 * If both sides don't fit side by side, each is truncated to roughly
 * half the available width with a single space in between.
 */
export function layout(
	left: string[],
	right: string[],
	separator: string,
	width: number,
): string {
	const leftStr = left.filter(Boolean).join(separator);
	const rightStr = right.filter(Boolean).join(separator);
	return joinLeftRight(leftStr, rightStr, width);
}

/**
 * Join two strings left/right within `width` columns.
 *
 * - Both fit with ≥1 space → padded layout.
 * - Don't fit together → each side truncated to half the width.
 * - One side empty → only the other side shown (truncated to width).
 */
export function joinLeftRight(
	left: string,
	right: string,
	width: number,
): string {
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1)
		return truncateToWidth(left + " ".repeat(gap) + right, width);

	const half = Math.max(1, Math.floor((width - 1) / 2));
	return (
		truncateToWidth(left, half) +
		" " +
		truncateToWidth(right, width - half - 1)
	);
}
