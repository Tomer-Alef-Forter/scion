import { describe, expect, it } from "vitest";
import {
	type DecodedFrame,
	encodeFrame,
	encodeJson,
	FrameDecoder,
	TAG_BINARY,
	TAG_JSON,
} from "./protocol.ts";

describe("encodeFrame", () => {
	it("writes a 4-byte BE length (tag + payload) followed by the tag byte and payload", () => {
		const frame = encodeFrame("json", "ab");
		expect(frame.readUInt32BE(0)).toBe("ab".length + 1);
		expect(frame.readUInt8(4)).toBe(TAG_JSON);
		expect(frame.subarray(5).toString("utf8")).toBe("ab");
	});

	it("uses TAG_BINARY for binary payloads", () => {
		const payload = Buffer.from([1, 2, 3, 4]);
		const frame = encodeFrame("binary", payload);
		expect(frame.readUInt32BE(0)).toBe(payload.length + 1);
		expect(frame.readUInt8(4)).toBe(TAG_BINARY);
		expect(frame.subarray(5)).toEqual(payload);
	});

	it("accepts a Buffer payload as-is for json frames without double-encoding", () => {
		const payload = Buffer.from("raw-json-bytes", "utf8");
		const frame = encodeFrame("json", payload);
		expect(frame.subarray(5)).toEqual(payload);
	});
});

describe("encodeJson", () => {
	it("JSON-stringifies the message and wraps it in a JSON-tagged frame", () => {
		const frame = encodeJson({ type: "ping", reqId: 1 });
		const decoder = new FrameDecoder();
		const frames: DecodedFrame[] = [];
		decoder.push(frame, (f) => frames.push(f));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.kind).toBe("json");
		expect(JSON.parse(frames[0]?.payload.toString("utf8") ?? "")).toEqual({
			type: "ping",
			reqId: 1,
		});
	});
});

describe("FrameDecoder", () => {
	it("decodes a single frame delivered in one chunk", () => {
		const decoder = new FrameDecoder();
		const frames: DecodedFrame[] = [];
		decoder.push(encodeFrame("json", "hello"), (f) => frames.push(f));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "json", payload: Buffer.from("hello") });
	});

	it("decodes multiple frames packed into a single chunk", () => {
		const decoder = new FrameDecoder();
		const chunk = Buffer.concat([
			encodeFrame("json", "one"),
			encodeFrame("binary", Buffer.from("two")),
			encodeFrame("json", "three"),
		]);
		const frames: DecodedFrame[] = [];
		decoder.push(chunk, (f) => frames.push(f));
		expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["one", "two", "three"]);
		expect(frames.map((f) => f.kind)).toEqual(["json", "binary", "json"]);
	});

	it("buffers a frame split across multiple chunks at arbitrary byte boundaries", () => {
		const decoder = new FrameDecoder();
		const full = encodeFrame("json", "split-payload-across-chunks");
		const frames: DecodedFrame[] = [];

		// Feed it back one byte at a time — the hardest possible chunking.
		for (let i = 0; i < full.length; i++) {
			decoder.push(full.subarray(i, i + 1), (f) => frames.push(f));
		}

		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.toString("utf8")).toBe("split-payload-across-chunks");
	});

	it("splits exactly at the length-header boundary (partial header, then rest)", () => {
		const decoder = new FrameDecoder();
		const full = encodeFrame("json", "abc");
		const frames: DecodedFrame[] = [];
		decoder.push(full.subarray(0, 2), (f) => frames.push(f)); // partial 4-byte header
		expect(frames).toHaveLength(0);
		decoder.push(full.subarray(2), (f) => frames.push(f)); // rest of header + tag + payload
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.toString("utf8")).toBe("abc");
	});

	it("leaves a trailing partial frame buffered until the rest arrives", () => {
		const decoder = new FrameDecoder();
		const first = encodeFrame("json", "complete");
		const second = encodeFrame("json", "incomplete-tail");
		const frames: DecodedFrame[] = [];

		decoder.push(Buffer.concat([first, second.subarray(0, 3)]), (f) => frames.push(f));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.toString("utf8")).toBe("complete");

		decoder.push(second.subarray(3), (f) => frames.push(f));
		expect(frames).toHaveLength(2);
		expect(frames[1]?.payload.toString("utf8")).toBe("incomplete-tail");
	});

	it("handles an empty payload frame", () => {
		const decoder = new FrameDecoder();
		const frames: DecodedFrame[] = [];
		decoder.push(encodeFrame("json", ""), (f) => frames.push(f));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.length).toBe(0);
	});
});
