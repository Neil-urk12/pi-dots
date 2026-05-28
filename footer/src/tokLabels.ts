// ── Tool name normalization for tok/s activity display ────────
//
// Maps raw tool names to short display labels.
// Unknown names are truncated to 8 chars.

const TOOL_LABEL_MAP: Record<string, string> = {
	edit: "edit",
	write: "write",
	bash: "bash",
	ctx_shell: "bash",
	read: "read",
	ctx_read: "read",
	Agent: "agent",
	agent_browser: "browser",
};

const PREFIX_MAP: [string, string][] = [
	["gitnexus_", "nexus"],
	["context7_", "docs"],
];

const MAX_UNKNOWN_LENGTH = 8;

export function normalizeToolLabel(toolName: string): string {
	if (!toolName) return "";

	// Direct match
	const direct = TOOL_LABEL_MAP[toolName];
	if (direct) return direct;

	// Prefix match
	for (const [prefix, label] of PREFIX_MAP) {
		if (toolName.startsWith(prefix)) return label;
	}

	// Truncate unknown
	return toolName.length > MAX_UNKNOWN_LENGTH
		? toolName.slice(0, MAX_UNKNOWN_LENGTH)
		: toolName;
}
