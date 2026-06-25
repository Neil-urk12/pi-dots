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

const DEFAULT_MAX_SIZE = 100;

export class OneShotBypass {
  private readonly bypasses = new Set<string>();
  private readonly sessionGrants = new Set<string>();
  private readonly maxSize: number;

  constructor({ maxSize = DEFAULT_MAX_SIZE }: { maxSize?: number } = {}) {
    this.maxSize = maxSize;
  }

  checkAndConsume(toolName: string, input: unknown): boolean {
    // Session grants allow tool for all calls (not consumed)
    if (this.sessionGrants.has(toolName)) {
      return true;
    }
    const key = makeBypassKey(toolName, input);
    if (this.bypasses.has(key)) {
      this.bypasses.delete(key);
      return true;
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

  clear(): void {
    this.bypasses.clear();
    this.sessionGrants.clear();
  }
}
