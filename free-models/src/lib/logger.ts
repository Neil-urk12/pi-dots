/**
 * Structured logging utility for free-models extension.
 *
 * Console: error-only by default. Set LOG_LEVEL=debug|info|warn to see more.
 * File:    debug by default. Override with PI_FREE_MODELS_LOG_LEVEL.
 * Path:    ~/.pi/free-models.log. Override with PI_FREE_MODELS_LOG_PATH.
 * Disable: PI_FREE_MODELS_FILE_LOG=false
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	namespace: string;
	message: string;
	data?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "error";
const fileLevel: LogLevel = (process.env.PI_FREE_MODELS_LOG_LEVEL as LogLevel) || "debug";

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
	return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function formatMessage(entry: LogEntry): string {
	let data = "";
	if (entry.data) {
		try {
			data = ` ${JSON.stringify(entry.data)}`;
		} catch {
			data = " [unserializable-data]";
		}
	}
	return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.namespace}] ${entry.message}${data}`;
}

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const DEFAULT_LOG_PATH = join(HOME_DIR, ".pi", "free-models.log");
export const LOG_PATH = process.env.PI_FREE_MODELS_LOG_PATH || DEFAULT_LOG_PATH;
const FILE_LOG_ENABLED = process.env.PI_FREE_MODELS_FILE_LOG !== "false";
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB rotation threshold

let rotationJustHappened = false;

/** Reset rotation guard — exported for testing only. */
export function _resetRotationGuard(): void {
	rotationJustHappened = false;
}

export function appendToFile(line: string): void {
	if (!FILE_LOG_ENABLED) return;
	try {
		const dir = dirname(LOG_PATH);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// Rotate if file exceeds size limit
		if (!rotationJustHappened) {
			try {
				const stat = statSync(LOG_PATH);
				if (stat.size > MAX_LOG_BYTES) {
					renameSync(LOG_PATH, `${LOG_PATH}.1`);
					rotationJustHappened = true;
				}
			} catch {
				// File doesn't exist yet — fine
			}
		}
		appendFileSync(LOG_PATH, `${line}\n`, "utf8");
	} catch {
		// Silently ignore file log failures
	}
}

function log(
	level: LogLevel,
	namespace: string,
	message: string,
	data?: Record<string, unknown>,
): void {
	const logToConsole = shouldLog(level, currentLevel);
	const logToFile = shouldLog(level, fileLevel);
	if (!logToConsole && !logToFile) return;

	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		namespace,
		message,
		data,
	};

	const formatted = formatMessage(entry);
	if (logToFile) {
		appendToFile(formatted);
	}

	if (!logToConsole) return;

	switch (level) {
		case "debug":
			console.debug(formatted);
			break;
		case "info":
			console.info(formatted);
			break;
		case "warn":
			console.warn(formatted);
			break;
		case "error":
			console.error(formatted);
			break;
	}
}

export const logger = {
	debug: (namespace: string, message: string, data?: Record<string, unknown>) =>
		log("debug", namespace, message, data),
	info: (namespace: string, message: string, data?: Record<string, unknown>) =>
		log("info", namespace, message, data),
	warn: (namespace: string, message: string, data?: Record<string, unknown>) =>
		log("warn", namespace, message, data),
	error: (namespace: string, message: string, data?: Record<string, unknown>) =>
		log("error", namespace, message, data),
};

/**
 * Create a namespaced logger instance.
 */
export function createLogger(namespace: string) {
	return {
		debug: (message: string, data?: Record<string, unknown>) =>
			logger.debug(namespace, message, data),
		info: (message: string, data?: Record<string, unknown>) => logger.info(namespace, message, data),
		warn: (message: string, data?: Record<string, unknown>) => logger.warn(namespace, message, data),
		error: (message: string, data?: Record<string, unknown>) =>
			logger.error(namespace, message, data),
	};
}
