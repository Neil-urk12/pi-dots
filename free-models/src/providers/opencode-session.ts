/**
 * OpenCode session/request tracking and per-request stream wrapper.
 *
 * OpenCode's server uses checkHeaders to distinguish native CLI requests from
 * third-party clients. Native identifiers use ULID-style prefixes:
 *
 *   Session:  ses_<hex><base62>   (e.g. ses_a1b2c3d4e5f6g7h8i9j0k1l2m3n4)
 *   Request:  msg_<hex><base62>   (e.g. msg_01KA1B2C3D4E5F6G7H8I9J0K1L2M)
 *
 * Without matching prefixes the server falls back to a ~2 req/day limit.
 *
 * createOpenCodeStreamSimple() returns a provider streamSimple that refreshes
 * headers for every LLM call, so Pi's static model headers (evaluated at
 * registration time) don't cause stale identifiers across turns.
 */

import { randomBytes } from "node:crypto";
import type {
	Api,
	Model,
	Context,
	SimpleStreamOptions,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export const OPENCODE_STATIC_HEADERS = {
	"User-Agent": "opencode/1.15.5",
	"x-opencode-client": "cli",
} as const;

function generateOpenCodeId(prefix: string): string {
	const ms = BigInt(Date.now());
	const timeHex = ms.toString(16).padStart(12, "0");
	const randomLen = 14;
	const base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const bytes = randomBytes(randomLen);
	let suffix = "";
	for (let i = 0; i < randomLen; i++) {
		suffix += base62Chars[bytes[i] % 62];
	}
	return `${prefix}${timeHex}${suffix}`;
}

export function createOpenCodeSessionTracker() {
	let sessionId = "";

	function getSessionId(): string {
		if (!sessionId) {
			sessionId = generateOpenCodeId("ses_");
		}
		return sessionId;
	}

	function nextRequestId(): string {
		return generateOpenCodeId("msg_");
	}

	return {
		getSessionId,
		nextRequestId,
	};
}

export type OpenCodeSessionTracker = ReturnType<typeof createOpenCodeSessionTracker>;

export function createOpenCodeHeaders(
	tracker: OpenCodeSessionTracker,
	existingHeaders?: Record<string, string>,
): Record<string, string> {
	return {
		...existingHeaders,
		...OPENCODE_STATIC_HEADERS,
		"x-opencode-session": tracker.getSessionId(),
		"x-opencode-request": tracker.nextRequestId(),
	};
}

export function isOpenCodeProvider(providerId: string): boolean {
	return providerId === "opencode" || providerId === "opencode-go";
}

// =============================================================================
// Per-request stream wrapper
// =============================================================================

/**
 * Deferred async iterator that lets us pipe upstream events through.
 * Used to wrap the upstream stream with refreshed OpenCode headers.
 */
class DeferredAssistantMessageEventStream {
	private queue: AssistantMessageEvent[] = [];
	private waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
	private done = false;
	private resolveResult!: (message: AssistantMessage) => void;
	private readonly finalResultPromise: Promise<AssistantMessage>;

	constructor() {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
	}

	push(event: AssistantMessageEvent): void {
		if (this.done) return;

		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.resolveResult(event.type === "done" ? event.message : event.error);
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: AssistantMessage): void {
		if (this.done) return;
		this.done = true;
		if (result) this.resolveResult(result);
		while (this.waiting.length > 0) {
			this.waiting.shift()?.({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
					this.waiting.push(resolve),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<AssistantMessage> {
		return this.finalResultPromise;
	}
}

function createErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	const message = error instanceof Error ? error.message : String(error);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

async function pipeStream(
	stream: DeferredAssistantMessageEventStream,
	upstream: AssistantMessageEventStream,
): Promise<void> {
	let finalMessage: AssistantMessage | undefined;
	try {
		for await (const event of upstream) {
			stream.push(event);
			if (event.type === "done") finalMessage = event.message;
			if (event.type === "error") finalMessage = event.error;
		}
		stream.end(finalMessage ?? (await upstream.result()));
	} catch (error) {
		if (finalMessage) {
			stream.end(finalMessage);
		} else {
			throw error;
		}
	}
}

/**
 * Pi's static model headers are evaluated at registration time. OpenCode treats
 * x-opencode-request like a per-request id, so reusing one value across turns
 * leaves later requests attached to an old/in-flight generation.
 *
 * This function returns a provider-specific streamSimple that keeps the normal
 * Pi parsers but refreshes OpenCode headers for every LLM call.
 */
export function createOpenCodeStreamSimple(
	tracker: OpenCodeSessionTracker,
): (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		const headers = createOpenCodeHeaders(tracker, options?.headers);
		const stream = new DeferredAssistantMessageEventStream();

		void (async () => {
			try {
				// Dynamic import to avoid loading pi-ai at extension load time
				const { streamSimpleOpenAICompletions } =
					(await import("@earendil-works/pi-ai/openai-completions")) as {
						streamSimpleOpenAICompletions: (
							model: Model<"openai-completions">,
							context: Context,
							options?: SimpleStreamOptions,
						) => AssistantMessageEventStream;
					};

				await pipeStream(
					stream,
					streamSimpleOpenAICompletions(
						{ ...model, api: "openai-completions" } as Model<"openai-completions">,
						context,
						{ ...options, headers },
					),
				);
			} catch (error) {
				const errorMessage = createErrorMessage(model, error);
				stream.push({ type: "start", partial: errorMessage });
				stream.push({ type: "error", reason: "error", error: errorMessage });
			}
		})();

		return stream as unknown as AssistantMessageEventStream;
	};
}
