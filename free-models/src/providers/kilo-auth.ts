/**
 * Kilo OAuth device authorization flow and token management.
 */

import { createLogger } from "../lib/logger.ts";
import { spawn } from "node:child_process";

const _logger = createLogger("kilo-auth");

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
const KILO_POLL_INTERVAL_MS = 3_000;
const KILO_TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// =============================================================================
// Device auth types
// =============================================================================

interface DeviceAuthResponse {
	code: string;
	verificationUrl: string;
	expiresIn: number;
}

interface DeviceAuthPollResponse {
	status: "pending" | "approved" | "denied" | "expired";
	token?: string;
}

interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
}

interface OAuthLoginCallbacks {
	onProgress?: (msg: string) => void;
	onAuth: (info: { url: string; instructions: string }) => void;
	signal?: AbortSignal;
}

// =============================================================================
// Helpers
// =============================================================================

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

function openBrowser(url: string): void {
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	if (platform === "darwin") {
		cmd = "open";
		args = [url];
	} else if (platform === "win32") {
		cmd = "cmd";
		args = ["/c", "start", "", url];
	} else {
		cmd = "xdg-open";
		args = [url];
	}
	spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

// =============================================================================
// Device auth
// =============================================================================

async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
	const response = await fetch(DEVICE_AUTH_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});
	if (!response.ok) {
		throw new Error(
			response.status === 429
				? "Too many pending authorization requests. Please try again later."
				: `Failed to initiate device authorization: ${response.status}`,
		);
	}
	return (await response.json()) as DeviceAuthResponse;
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
	const response = await fetch(`${DEVICE_AUTH_ENDPOINT}/${code}`);
	if (response.status === 202) return { status: "pending" };
	if (response.status === 403) return { status: "denied" };
	if (response.status === 410) return { status: "expired" };
	if (!response.ok) throw new Error(`Failed to poll device authorization: ${response.status}`);
	return (await response.json()) as DeviceAuthPollResponse;
}

// =============================================================================
// Public API
// =============================================================================

export async function loginKilo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Initiating device authorization...");
	const { code, verificationUrl, expiresIn } = await initiateDeviceAuth();

	callbacks.onAuth({
		url: verificationUrl,
		instructions: `Enter code: ${code}`,
	});
	openBrowser(verificationUrl);
	callbacks.onProgress?.("Waiting for browser authorization...");

	const deadline = Date.now() + expiresIn * 1000;
	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");
		await abortableSleep(KILO_POLL_INTERVAL_MS, callbacks.signal);

		const result = await pollDeviceAuth(code);
		if (result.status === "approved") {
			if (!result.token) throw new Error("Authorization approved but no token received");
			callbacks.onProgress?.("Login successful!");
			return {
				refresh: result.token,
				access: result.token,
				expires: Date.now() + KILO_TOKEN_EXPIRATION_MS,
			};
		}
		if (result.status === "denied") throw new Error("Authorization denied by user.");
		if (result.status === "expired") throw new Error("Authorization code expired. Please try again.");

		const remaining = Math.ceil((deadline - Date.now()) / 1000);
		callbacks.onProgress?.(`Waiting for browser authorization... (${remaining}s remaining)`);
	}
	throw new Error("Authentication timed out. Please try again.");
}

export async function refreshKiloToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (credentials.expires > Date.now()) return credentials;
	throw new Error("Kilo token expired. Please run /login kilo to re-authenticate.");
}
