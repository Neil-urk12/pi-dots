import type { ModeDefinition, BashPatternSeverity, ResolvedBashPatterns, BashPatternConfig } from "./types.js";

export interface RenderPatternsOptions {
  mode: string;
  definition: ModeDefinition;
  bashPatterns: ResolvedBashPatterns;
  globalBashPatterns?: BashPatternConfig;
}

interface PatternEntry {
  pattern: string;
  severity: BashPatternSeverity | null; // null = uses bash_policy default
  source: "builtin" | "mode" | "user";
  isSafe: boolean;
}

/** Count patterns by effective severity for a given bash_policy */
function countSeverity(entries: PatternEntry[], bashPolicy: string) {
  let block = 0;
  let ask = 0;
  let allow = 0;
  for (const e of entries) {
    const s = e.isSafe ? "allow" : (e.severity ?? null);
    if (e.isSafe || s === "allow") allow++;
    else if (s === "ask") ask++;
    else if (s === "block") block++;
    else {
      // null severity — determined by bash_policy
      if (bashPolicy === "non_destructive" || bashPolicy === "strict_readonly") {
        block++;
      } else {
        allow++;
      }
    }
  }
  return { block, ask, allow };
}

/** Resolve effective severity for display */
function effectiveSeverity(e: PatternEntry, bashPolicy: string): BashPatternSeverity {
  const s = e.isSafe ? "allow" : (e.severity ?? null);
  if (e.isSafe || s === "allow") return "allow";
  if (s === "ask") return "ask";
  if (s === "block") return "block";
  // null severity — determined by bash_policy
  return bashPolicy === "off" ? "allow" : "block";
}

/**
 * Render a set of options for the bash patterns inspection dialog.
 * Returns an array of strings suitable for ctx.ui.select.
 */
export function renderPatternsDialog(options: RenderPatternsOptions): string[] {
  const { mode, definition, bashPatterns, globalBashPatterns } = options;
  const lines: string[] = [];
  const bashPolicy = definition.bash_policy ?? "strict_readonly";

  // 1. Build all pattern entries with effective severity
  const entries: PatternEntry[] = [];

  // Safe patterns — always ALLOW
  for (const pattern of bashPatterns.safeSource ?? []) {
    entries.push({ pattern, severity: "allow", source: "builtin", isSafe: true });
  }

  // Destructive patterns — check severity overrides
  const severityMap = bashPatterns.severity;
  const userOverridden = new Set<string>();

  if (globalBashPatterns?.destructive?.severity) {
    for (const p of Object.keys(globalBashPatterns.destructive.severity)) {
      userOverridden.add(p);
    }
  }

  const modeSeverity = definition.bash_patterns?.destructive?.severity;
  if (modeSeverity) {
    for (const p of Object.keys(modeSeverity)) {
      if (!userOverridden.has(p)) {
        userOverridden.add(p + ":mode");
      }
    }
  }

  for (const pattern of bashPatterns.destructiveSource ?? []) {
    const sev = severityMap?.get(pattern) ?? null;
    const isOverriddenAtUser = globalBashPatterns?.destructive?.severity?.[pattern] !== undefined;

    let source: "builtin" | "mode" | "user" = "builtin";
    if (isOverriddenAtUser) {
      source = "user";
    } else if (severityMap?.has(pattern)) {
      source = "mode";
    }

    entries.push({ pattern, severity: sev, source, isSafe: false });
  }

  // 2. Sort by severity tier: BLOCK → ASK → ALLOW
  const sevOrder: Record<string, number> = { block: 0, ask: 1, allow: 2 };
  entries.sort((a, b) => {
    const aKey = effectiveSeverity(a, bashPolicy);
    const bKey = effectiveSeverity(b, bashPolicy);
    return (sevOrder[aKey] ?? 99) - (sevOrder[bKey] ?? 99);
  });

  // 3. Count header
  const counts = countSeverity(entries, bashPolicy);
  lines.push(`  🔴 BLOCK (${counts.block})  🟠 ASK (${counts.ask})  🟢 ALLOW (${counts.allow})`);
  lines.push("");

  // 4. Render each pattern
  for (const e of entries) {
    const sev = effectiveSeverity(e, bashPolicy);
    const badge = sev === "block" ? "🔴" : sev === "ask" ? "🟠" : "🟢";
    let suffix = "";
    if (e.source === "user") suffix = "  ← user config";
    else if (e.source === "mode") suffix = "  ← mode override";
    lines.push(`  ${badge} ${e.pattern}${suffix}`);
  }

  // 5. Footer
  lines.push("");
  lines.push(`  mode=${mode} | bash_policy=${bashPolicy}`);
  lines.push(`  config: ~/.pi/modes/config.yaml`);

  return lines;
}
