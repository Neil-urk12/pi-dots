/**
 * Escape regex metacharacters in a string so it can be used safely in a RegExp.
 */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import type { ContentBlock } from "./types";

/**
 * Extract text content from pi's JSON mode message content blocks.
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as ContentBlock[])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
	}
	return "";
}
