function makeBypassKey(toolName: string, input: unknown): string {
  let args = "";
  if (input && typeof input === "object") {
    try {
      args = JSON.stringify(input, (_key, val) => {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          return Object.keys(val).sort().reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = (val as Record<string, unknown>)[k];
            return sorted;
          }, {});
        }
        return val;
      });
    } catch {
      args = "<unserializable>";
    }
  }
  return `${toolName}:${args}`;
}

/** Extract command string from input for prefix matching */
function commandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as { command?: unknown }).command;
  return typeof value === "string" ? value.trim() : "";
}

const DEFAULT_MAX_SIZE = 100;

export class OneShotBypass {
  private readonly bypasses = new Set<string>();
  private readonly sessionGrants = new Set<string>();
  private readonly prefixBypasses = new Map<string, string>();      // key → prefix
  private readonly sessionPrefixGrants = new Map<string, string>(); // key → prefix
  private readonly maxSize: number;

  constructor({ maxSize = DEFAULT_MAX_SIZE }: { maxSize?: number } = {}) {
    this.maxSize = maxSize;
  }

  checkAndConsume(toolName: string, input: unknown): boolean {
    // Session grants allow tool for all calls (not consumed)
    if (this.sessionGrants.has(toolName)) {
      return true;
    }

    // Session prefix grants allow matching commands (not consumed)
    const command = commandFromInput(input);
    for (const [key, prefix] of this.sessionPrefixGrants) {
      if (toolName === key.split(":")[0] && command.startsWith(prefix)) {
        return true;
      }
    }

    // One-shot exact bypass (consumed)
    const bypassKey = makeBypassKey(toolName, input);
    if (this.bypasses.has(bypassKey)) {
      this.bypasses.delete(bypassKey);
      return true;
    }

    // One-shot prefix bypass (consumed on match)
    for (const [key, prefix] of this.prefixBypasses) {
      if (key.startsWith(`${toolName}:`) && command.startsWith(prefix)) {
        this.prefixBypasses.delete(key);
        return true;
      }
    }

    return false;
  }

  grant(toolName: string, input: unknown): void {
    if (this.bypasses.size >= this.maxSize) {
      const oldest = this.bypasses.values().next().value;
      if (oldest) this.bypasses.delete(oldest);
    }
    this.bypasses.add(makeBypassKey(toolName, input));
  }

  grantSession(toolName: string): void {
    this.sessionGrants.add(toolName);
  }

  grantPrefix(toolName: string, command: string): void {
    const key = `${toolName}:${command.trim()}`;
    this.prefixBypasses.set(key, command.trim());
  }

  grantSessionPrefix(toolName: string, command: string): void {
    const key = `${toolName}:${command.trim()}`;
    this.sessionPrefixGrants.set(key, command.trim());
  }

  clear(): void {
    this.bypasses.clear();
    this.sessionGrants.clear();
    this.prefixBypasses.clear();
    this.sessionPrefixGrants.clear();
  }
}
