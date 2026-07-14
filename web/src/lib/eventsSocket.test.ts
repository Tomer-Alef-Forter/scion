import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToStatusEvents } from "./eventsSocket";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	url: string;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	closed = false;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	close(): void {
		this.closed = true;
	}
	emitMessage(data: unknown): void {
		this.onmessage?.({ data });
	}
	emitClose(): void {
		this.onclose?.();
	}
}

function latestSocket(): FakeWebSocket {
	const s = FakeWebSocket.instances.at(-1);
	if (!s) throw new Error("no FakeWebSocket instance created yet");
	return s;
}

describe("subscribeToStatusEvents", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("connects to the same-origin /ws/events endpoint", () => {
		const unsubscribe = subscribeToStatusEvents(vi.fn());
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(new URL(latestSocket().url).pathname).toBe("/ws/events");
		unsubscribe();
	});

	it("calls onChange with the workspaceId for a well-formed status message", () => {
		const onChange = vi.fn();
		const unsubscribe = subscribeToStatusEvents(onChange);
		latestSocket().emitMessage(JSON.stringify({ type: "status", workspaceId: "ws-42" }));
		expect(onChange).toHaveBeenCalledWith("ws-42");
		unsubscribe();
	});

	it("ignores malformed JSON without throwing", () => {
		const onChange = vi.fn();
		const unsubscribe = subscribeToStatusEvents(onChange);
		expect(() => latestSocket().emitMessage("not json")).not.toThrow();
		expect(onChange).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("ignores well-formed JSON of the wrong shape", () => {
		const onChange = vi.fn();
		const unsubscribe = subscribeToStatusEvents(onChange);
		latestSocket().emitMessage(JSON.stringify({ type: "other" }));
		latestSocket().emitMessage(JSON.stringify({ type: "status" })); // no workspaceId
		expect(onChange).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("reconnects 1000ms after an unexpected close", () => {
		const unsubscribe = subscribeToStatusEvents(vi.fn());
		latestSocket().emitClose();
		vi.advanceTimersByTime(999);
		expect(FakeWebSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
		unsubscribe();
	});

	it("unsubscribe() closes the socket and cancels a pending reconnect timer", () => {
		const unsubscribe = subscribeToStatusEvents(vi.fn());
		const first = latestSocket();
		latestSocket().emitClose();
		unsubscribe();
		expect(first.closed).toBe(true);
		vi.advanceTimersByTime(5000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});
