export function injectIntoPayload(payload: unknown, text: string): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const target = payload as any;

  if (typeof target.system === "string") {
    target.system += text;
  } else if (Array.isArray(target.system)) {
    target.system.push({ type: "text", text });
  } else if (Array.isArray(target.messages)) {
    const sysMsg = target.messages.find((m: any) => m.role === "system");
    if (sysMsg) {
      if (typeof sysMsg.content === "string") sysMsg.content += text;
      else if (Array.isArray(sysMsg.content)) sysMsg.content.push({ type: "text", text });
    } else {
      target.messages.unshift({ role: "system", content: text });
    }
  }

  return payload;
}
