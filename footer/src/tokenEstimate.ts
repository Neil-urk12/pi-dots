/**
 * CJK-aware token estimation.
 *
 * Estimates token count by assigning different weights per character
 * based on Unicode script family. Values derived from tiktoken cl100k_base
 * empirical ratios.
 *
 * @see https://github.com/openai/tiktoken
 */

const TOK_ASCII = 0.25; // ASCII printable (0x20-0x7E)
const TOK_CJK_IDEO = 0.67; // CJK ideographs, kana, hangul
const TOK_CJK_PUNCT = 0.5; // CJK Symbols & Punctuation (0x3000-0x303f)
const TOK_NON_BMP = 1; // Emoji / non-BMP (U+10000+): 2 UTF-16 units ≈ 1 token
const TOK_OTHER = 0.5; // Latin extended, Cyrillic, etc.

/**
 * Estimate token count for a string using character-class weights.
 *
 * Iterates Unicode code points and accumulates fractional token weights:
 * - ASCII printable (0x20–0x7E): ~0.25 tok/char
 * - CJK ideographs, kana, hangul, fullwidth forms: ~0.67 tok/char
 * - CJK punctuation (U+3000–U+303F): ~0.5 tok/char
 * - Non-BMP / emoji (U+10000+): ~1 tok/char
 * - Everything else (Latin extended, Cyrillic, …): ~0.5 tok/char
 *
 * Result is `Math.ceil` of the accumulated total.
 */
export function estimateTokens(text: string): number {
	let total = 0;
	for (const char of text) {
		const cp = char.codePointAt(0) ?? 0;
		if (cp >= 0x20 && cp <= 0x7E) {
			total += TOK_ASCII;
		} else if (
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
			(cp >= 0x3040 && cp <= 0x309f) || // Hiragana
			(cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
			(cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
			(cp >= 0x2e80 && cp <= 0x2fdf) || // CJK Radicals Supplement + Kangxi Radicals
			(cp >= 0x3100 && cp <= 0x312f) || // Bopomofo
			(cp >= 0x31f0 && cp <= 0x31ff) || // Katakana Phonetic Extensions
			(cp >= 0xff01 && cp <= 0xff5e) || // Fullwidth printable ASCII (! through ~)
			(cp >= 0xff65 && cp <= 0xff9f) // Halfwidth Katakana
		) {
			total += TOK_CJK_IDEO;
		} else if (cp >= 0x3000 && cp <= 0x303f) {
			// CJK Symbols and Punctuation: lighter than ideographs
			total += TOK_CJK_PUNCT;
		} else if (cp > 0xffff) {
			total += TOK_NON_BMP;
		} else {
			total += TOK_OTHER;
		}
	}
	return Math.ceil(total);
}
