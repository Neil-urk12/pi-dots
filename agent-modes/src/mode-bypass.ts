function makeBypassKey(toolName: string, input: unknown): string {
  let args = "";
  if (input && typeof input === "object") {
    try {
      args = JSON.stringify(input, (_key, value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          }, {});
        }
        return value;
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
  private readonly maxSize: number;

  constructor({ maxSize = DEFAULT_MAX_SIZE }: { maxSize?: number } = {}) {
    this.maxSize = maxSize;
  }

  checkAndConsume(toolName: string, input: unknown): boolean {
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

  clear(): void {
    this.bypasses.clear();
  }
}
