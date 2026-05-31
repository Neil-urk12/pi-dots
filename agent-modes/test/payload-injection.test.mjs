import { test, expect } from "vitest";
import { injectIntoPayload } from "../dist/index.js";

test("appends injection to string system payload and returns payload", () => {
  const payload = { system: "base" };

  const result = injectIntoPayload(payload, "\nmode");

  expect(result).toBe(payload);
  expect(payload.system).toBe("base\nmode");
});

test("appends injection to array system payload and returns payload", () => {
  const payload = { system: [{ type: "text", text: "base" }] };

  const result = injectIntoPayload(payload, "mode");

  expect(result).toBe(payload);
  expect(payload.system.at(-1)).toEqual({ type: "text", text: "mode" });
});

test("appends injection to existing system message content", () => {
  const payload = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };

  const result = injectIntoPayload(payload, "\nmode");

  expect(result).toBe(payload);
  expect(payload.messages[0].content).toBe("base\nmode");
});

test("prepends system message when messages payload lacks one", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };

  const result = injectIntoPayload(payload, "mode");

  expect(result).toBe(payload);
  expect(payload.messages[0]).toEqual({ role: "system", content: "mode" });
});
