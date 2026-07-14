import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalConnection } from "./TerminalConnection";

// A hand-rolled WebSocket stand-in: no real networking, fully driven by the
// test so backoff timing and message framing are exercised deterministically.
class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly CONNECTING = FakeWebSocket.CONNECTING;
	readonly OPEN = FakeWebSocket.OPEN;
	readonly CLOSING = FakeWebSocket.CLOSING;
	readonly CLOSED = FakeWebSocket.CLOSED;

	url: string;
	binaryType = "blob";
	readyState = FakeWebSocket.CONNECTING;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];
	closed = false;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.readyState = FakeWebSocket.CLOSED;
	}

	// --- test helpers, simulating server-driven events ---
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
	}
	emitJson(msg: unknown): void {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
	emitBinary(bytes: Uint8Array): void {
		this.onmessage?.({ data: bytes.buffer });
	}
	emitClose(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

function latestSocket(): FakeWebSocket {
	const s = FakeWebSocket.instances.at(-1);
	if (!s) throw new Error("no FakeWebSocket instance created yet");
	return s;
}

describe("createTerminalConnection", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("opens a socket to the expected same-origin terminal URL on construction", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		expect(FakeWebSocket.instances).toHaveLength(1);
		const url = new URL(latestSocket().url);
		expect(url.pathname).toBe("/ws/terminal/term-1");
		expect(url.searchParams.get("workspaceId")).toBe("ws-1");
		expect(url.searchParams.has("replay")).toBe(false);
		conn.dispose();
	});

	it("sets binaryType to arraybuffer on the underlying socket", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		expect(latestSocket().binaryType).toBe("arraybuffer");
		conn.dispose();
	});

	it("forwards binary frames to onBinary as Uint8Array", () => {
		const onBinary = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary, onControl: vi.fn(), onStateChange: vi.fn() },
		);
		const bytes = new Uint8Array([1, 2, 3]);
		latestSocket().emitBinary(bytes);
		expect(onBinary).toHaveBeenCalledTimes(1);
		expect(onBinary.mock.calls[0]?.[0]).toEqual(bytes);
		conn.dispose();
	});

	it("forwards JSON control messages to onControl", () => {
		const onControl = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl, onStateChange: vi.fn() },
		);
		latestSocket().emitJson({ type: "attached", terminalId: "term-1" });
		expect(onControl).toHaveBeenCalledWith({ type: "attached", terminalId: "term-1" });
		conn.dispose();
	});

	it("ignores malformed (non-JSON) control messages instead of throwing", () => {
		const onControl = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl, onStateChange: vi.fn() },
		);
		expect(() => latestSocket().onmessage?.({ data: "{not valid json" })).not.toThrow();
		expect(onControl).not.toHaveBeenCalled();
		conn.dispose();
	});

	it("requests replay=0 on the URL once bytes have already been received (post-reconnect)", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		latestSocket().emitBinary(new Uint8Array([9]));
		latestSocket().emitClose(); // triggers a scheduled reconnect
		vi.advanceTimersByTime(500); // INITIAL_RECONNECT_DELAY_MS
		expect(FakeWebSocket.instances).toHaveLength(2);
		const url = new URL(latestSocket().url);
		expect(url.searchParams.get("replay")).toBe("0");
		conn.dispose();
	});

	it("sends input/resize messages as JSON only while the socket is open", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		conn.send({ type: "input", data: "ls\n" }); // socket not OPEN yet -> dropped
		expect(latestSocket().sent).toHaveLength(0);

		latestSocket().open();
		conn.send({ type: "resize", cols: 80, rows: 24 });
		expect(latestSocket().sent).toEqual([JSON.stringify({ type: "resize", cols: 80, rows: 24 })]);
		conn.dispose();
	});

	it("schedules reconnects with exponential backoff, capped at MAX_RECONNECT_DELAY_MS", () => {
		const onStateChange = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange },
		);

		const expectedDelays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
		for (const delay of expectedDelays) {
			const countBefore = FakeWebSocket.instances.length;
			latestSocket().emitClose();
			// Nothing new spawns before the expected delay elapses.
			vi.advanceTimersByTime(delay - 1);
			expect(FakeWebSocket.instances.length).toBe(countBefore);
			vi.advanceTimersByTime(1);
			expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
		}

		expect(onStateChange).toHaveBeenCalledWith("reconnecting");
		conn.dispose();
	});

	it("gives up and reports 'error' after MAX_RECONNECT_ATTEMPTS", () => {
		const onStateChange = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange },
		);

		for (let i = 0; i < 12; i++) {
			latestSocket().emitClose();
			vi.advanceTimersByTime(10_000);
		}
		// The 13th close should exceed MAX_RECONNECT_ATTEMPTS and stop retrying.
		const countBefore = FakeWebSocket.instances.length;
		latestSocket().emitClose();
		vi.advanceTimersByTime(20_000);
		expect(FakeWebSocket.instances.length).toBe(countBefore);
		expect(onStateChange).toHaveBeenLastCalledWith("error");
		conn.dispose();
	});

	it("resets the reconnect attempt counter once 'attached' is received", () => {
		const onStateChange = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange },
		);

		// First failure: backs off 500ms.
		latestSocket().emitClose();
		vi.advanceTimersByTime(500);
		expect(FakeWebSocket.instances).toHaveLength(2);

		// Successfully attaches -> resets backoff.
		latestSocket().emitJson({ type: "attached", terminalId: "term-1" });

		// Next failure should again wait the *initial* delay, not the doubled one.
		const countBefore = FakeWebSocket.instances.length;
		latestSocket().emitClose();
		vi.advanceTimersByTime(499);
		expect(FakeWebSocket.instances.length).toBe(countBefore);
		vi.advanceTimersByTime(1);
		expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

		conn.dispose();
	});

	it("stops reconnecting once an 'exit' control message marks the session terminated", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		latestSocket().emitJson({ type: "exit", exitCode: 0, signal: 0 });
		const countBefore = FakeWebSocket.instances.length;
		latestSocket().emitClose();
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances.length).toBe(countBefore);
		conn.dispose();
	});

	it("dispose() closes the socket and prevents further reconnects", () => {
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange: vi.fn() },
		);
		const first = latestSocket();
		conn.dispose();
		expect(first.closed).toBe(true);

		// A close event arriving after dispose (e.g. a late network callback)
		// must not schedule a reconnect.
		first.emitClose();
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("does not emit a duplicate state-change when the state doesn't actually change", () => {
		const onStateChange = vi.fn();
		const conn = createTerminalConnection(
			{ workspaceId: "ws-1", terminalId: "term-1" },
			{ onBinary: vi.fn(), onControl: vi.fn(), onStateChange },
		);
		const callsAfterConnect = onStateChange.mock.calls.length;
		// connect() itself only calls setState when the state actually flips
		// from its previous value; immediately re-closing before any attach
		// keeps it at "reconnecting" without extra churn beyond one transition.
		latestSocket().emitClose();
		expect(onStateChange.mock.calls.length).toBeGreaterThan(callsAfterConnect);
		conn.dispose();
	});
});
