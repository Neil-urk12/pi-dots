import type { Totals, ColorFn } from "./types.js";
import { formatCount } from "./utils.js";

export function formatFullTokens(
	totals: Totals,
	opts: { showCacheRead: boolean; showCacheWrites: boolean; cf: ColorFn; color: string },
): string {
	const total = totals.input + totals.output;
	const base = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)} Σ${formatCount(total)}`;
	const cacheParts = [
		opts.showCacheRead ? `↯${formatCount(totals.cacheRead)}` : undefined,
		opts.showCacheWrites ? `↥${formatCount(totals.cacheWrite)}` : undefined,
	].filter(Boolean);
	const text = cacheParts.length ? `${base} ${cacheParts.join(" ")}` : base;
	return opts.cf(opts.color, text);
}

export function formatNoCacheTokens(totals: Totals, cf: ColorFn, color: string): string {
	const total = totals.input + totals.output;
	const text = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)} Σ${formatCount(total)}`;
	return cf(color, text);
}

export function formatTotalOnlyTokens(totals: Totals, cf: ColorFn, color: string): string {
	const total = totals.input + totals.output;
	return cf(color, `Σ${formatCount(total)}`);
}
