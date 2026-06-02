/**
 * Tests for logger file rotation logic.
 * Validates rotation guard prevents data loss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// Mock fs before importing logger
vi.mock("node:fs", () => ({
	appendFileSync: vi.fn(),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	statSync: vi.fn(() => ({ size: 0 })),
	renameSync: vi.fn(),
}));

// Import after mock setup
import { appendToFile, MAX_LOG_BYTES, LOG_PATH, _resetRotationGuard } from './logger.ts';

describe("logger rotation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetRotationGuard();
	});

	it("does not rotate when file is under threshold", () => {
		vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as fs.Stats);
		appendToFile("test line");
		expect(fs.renameSync).not.toHaveBeenCalled();
		expect(fs.appendFileSync).toHaveBeenCalledWith(LOG_PATH, "test line\n", "utf8");
	});

	it("rotates when file exceeds MAX_LOG_BYTES", () => {
		vi.mocked(fs.statSync).mockReturnValue({ size: MAX_LOG_BYTES + 1 } as fs.Stats);
		appendToFile("test line");
		expect(fs.renameSync).toHaveBeenCalledWith(LOG_PATH, `${LOG_PATH}.1`);
		expect(fs.appendFileSync).toHaveBeenCalled();
	});

	it("does not rotate again immediately after rotation", () => {
		// First call: file is oversized → triggers rotation
		vi.mocked(fs.statSync).mockReturnValue({ size: MAX_LOG_BYTES + 1 } as fs.Stats);
		appendToFile("line 1");
		expect(fs.renameSync).toHaveBeenCalledTimes(1);

		// Second call: statSync would still return large size for the renamed file,
		// but a guard should prevent double-rotation
		vi.mocked(fs.statSync).mockReturnValue({ size: MAX_LOG_BYTES + 1 } as fs.Stats);
		appendToFile("line 2");

		// Should NOT have rotated again — guard should prevent it
		expect(fs.renameSync).toHaveBeenCalledTimes(1);
		// Should still append
		expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
	});

	it("handles statSync throwing (file doesn't exist yet)", () => {
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		appendToFile("first line");
		// Should not throw, should still append
		expect(fs.appendFileSync).toHaveBeenCalledWith(LOG_PATH, "first line\n", "utf8");
		expect(fs.renameSync).not.toHaveBeenCalled();
	});
});
