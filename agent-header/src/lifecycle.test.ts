import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HeaderLifecycle } from "./lifecycle.js";

function makeMockCtx() {
	return {
		hasUI: true,
		cwd: "/tmp/test-project",
		ui: {
			setHeader: vi.fn(),
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function makeLifecycle() {
	return new HeaderLifecycle({
		globalConfigPath: "/tmp/pi-header.json",
		getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
		onRenderNeeded: () => {},
	});
}


// HeaderInput type — version field is dead code in rendering path
describe("HeaderInput type", () => {
	it("does not have a version field", () => {
		const srcPath = join(import.meta.dirname, "types.ts");
		const source = readFileSync(srcPath, "utf8");

		// Find the HeaderInput type definition
		const typeStart = source.indexOf("export type HeaderInput");
		expect(typeStart).toBeGreaterThan(-1);
		const typeEnd = source.indexOf("};", typeStart);
		const typeBody = source.slice(typeStart, typeEnd);

		// version should NOT be a field — it is dead code in the renderer path
		expect(typeBody).not.toMatch(/\bversion\s*:/);
	});
});

// HeaderLifecycle — lifecycle management with optional git state
describe("HeaderLifecycle", () => {
	it("can be constructed", () => {
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});
		expect(lifecycle).toBeInstanceOf(HeaderLifecycle);
	});

	it("toggle() returns enabled state", async () => {
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});
		const enabled = await lifecycle.toggle();
		expect(typeof enabled).toBe("boolean");
	});

	it("start/shutdown/start cycle works without errors", async () => {
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});

		const ctx1 = makeMockCtx();
		await lifecycle.start(ctx1);
		lifecycle.shutdown();

		// Second start after shutdown — exercises #git non-null assertion path
		const ctx2 = makeMockCtx();
		await lifecycle.start(ctx2);

		lifecycle.shutdown();
	});

	it("start/toggle/start cycle works without errors", async () => {
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});

		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		await lifecycle.toggle();
		await lifecycle.toggle();

		// Start again after toggle cycle
		await lifecycle.start(ctx);

		lifecycle.shutdown();
	});

	it("getInput() returns render payload", async () => {
		const onRenderNeeded = vi.fn();
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded,
		});
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		const input = lifecycle.getInput(ctx);
		expect(input.name).toBe("Agent-Pi");
		expect(input).not.toHaveProperty("version");
		expect(input.directory).toBe("test-project");
		expect(input.config).toBeDefined();
	});

	it("getInput() does not include version field (dead code in renderer)", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		const input = lifecycle.getInput(ctx);
		expect(input).not.toHaveProperty("version");
	});

	it("onToolExecutionEnd does not throw", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		expect(() => lifecycle.onToolExecutionEnd("bash")).not.toThrow();
		expect(() => lifecycle.onToolExecutionEnd("edit")).not.toThrow();
		expect(() => lifecycle.onToolExecutionEnd("write")).not.toThrow();
		expect(() => lifecycle.onToolExecutionEnd("read")).not.toThrow();
	});

	it("onToolExecutionEnd triggers git.schedule for trigger tools", async () => {
		const mockSchedule = vi.fn();
		vi.doMock("./git.js", () => ({
			createGitState: vi.fn(() => ({
				state: {},
				refresh: vi.fn().mockResolvedValue(undefined),
				schedule: mockSchedule,
				clear: vi.fn(),
			})),
		}));

		vi.resetModules();
		const { HeaderLifecycle: FreshLifecycle } = await import("./lifecycle.js");
		const lifecycle = new FreshLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		mockSchedule.mockClear();
		lifecycle.onToolExecutionEnd("bash");
		expect(mockSchedule).toHaveBeenCalledTimes(1);

		lifecycle.onToolExecutionEnd("edit");
		expect(mockSchedule).toHaveBeenCalledTimes(2);

		lifecycle.onToolExecutionEnd("write");
		expect(mockSchedule).toHaveBeenCalledTimes(3);

		vi.doUnmock("./git.js");
		vi.resetModules();
	});

	it("onToolExecutionEnd does NOT trigger git.schedule for non-trigger tools", async () => {
		const mockSchedule = vi.fn();
		vi.doMock("./git.js", () => ({
			createGitState: vi.fn(() => ({
				state: {},
				refresh: vi.fn().mockResolvedValue(undefined),
				schedule: mockSchedule,
				clear: vi.fn(),
			})),
		}));

		vi.resetModules();
		const { HeaderLifecycle: FreshLifecycle } = await import("./lifecycle.js");
		const lifecycle = new FreshLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		mockSchedule.mockClear();
		lifecycle.onToolExecutionEnd("read");
		expect(mockSchedule).not.toHaveBeenCalled();

		lifecycle.onToolExecutionEnd("glob");
		expect(mockSchedule).not.toHaveBeenCalled();

		vi.doUnmock("./git.js");
		vi.resetModules();
	});

	it("onModelSelect calls onRenderNeeded", async () => {
		const onRenderNeeded = vi.fn();
		const lifecycle = new HeaderLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded,
		});
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		onRenderNeeded.mockClear();
		lifecycle.onModelSelect();
		expect(onRenderNeeded).toHaveBeenCalledTimes(1);
	});

	it("onUserBash triggers git.schedule", async () => {
		const mockSchedule = vi.fn();
		vi.doMock("./git.js", () => ({
			createGitState: vi.fn(() => ({
				state: {},
				refresh: vi.fn().mockResolvedValue(undefined),
				schedule: mockSchedule,
				clear: vi.fn(),
			})),
		}));

		vi.resetModules();
		const { HeaderLifecycle: FreshLifecycle } = await import("./lifecycle.js");
		const lifecycle = new FreshLifecycle({
			globalConfigPath: "/tmp/pi-header.json",
			getProjectConfigPath: (cwd: string) => `${cwd}/.pi/pi-header.json`,
			onRenderNeeded: () => {},
		});
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);

		mockSchedule.mockClear();
		lifecycle.onUserBash();
		expect(mockSchedule).toHaveBeenCalledTimes(1);

		vi.doUnmock("./git.js");
		vi.resetModules();
	});

	it("loadedPaths getter returns loaded config paths", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		expect(Array.isArray(lifecycle.loadedPaths)).toBe(true);
	});

	it("loadedWarnings getter returns warnings array", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		expect(Array.isArray(lifecycle.loadedWarnings)).toBe(true);
	});

	it("loadedError getter returns string or undefined", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		expect(typeof lifecycle.loadedError === "string" || lifecycle.loadedError === undefined).toBe(true);
	});

	it("isEnabled getter reflects state", async () => {
		const lifecycle = makeLifecycle();
		expect(lifecycle.isEnabled).toBe(true);
		await lifecycle.toggle();
		expect(lifecycle.isEnabled).toBe(false);
		await lifecycle.toggle();
		expect(lifecycle.isEnabled).toBe(true);
	});

	it("reload() updates config", async () => {
		const lifecycle = makeLifecycle();
		const ctx = makeMockCtx();
		await lifecycle.start(ctx);
		await lifecycle.reload(ctx);
		expect(lifecycle.config).toBeDefined();
	});
});
