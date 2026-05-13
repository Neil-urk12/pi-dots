import test from "node:test";
import assert from "node:assert/strict";
import { injectIntoPayload } from "../dist/payload-injection.js";

test("appends injection to string system payload and returns payload", () => {
  const payload = { system: "base" };

  const result = injectIntoPayload(payload, "\nmode");

  assert.equal(result, payload);
  assert.equal(payload.system, "base\nmode");
});

test("appends injection to array system payload and returns payload", () => {
  const payload = { system: [{ type: "text", text: "base" }] };

  const result = injectIntoPayload(payload, "mode");

  assert.equal(result, payload);
  assert.deepEqual(payload.system.at(-1), { type: "text", text: "mode" });
});

test("appends injection to existing system message content", () => {
  const payload = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };

  const result = injectIntoPayload(payload, "\nmode");

  assert.equal(result, payload);
  assert.equal(payload.messages[0].content, "base\nmode");
});

test("prepends system message when messages payload lacks one", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };

  const result = injectIntoPayload(payload, "mode");

  assert.equal(result, payload);
  assert.deepEqual(payload.messages[0], { role: "system", content: "mode" });
});
