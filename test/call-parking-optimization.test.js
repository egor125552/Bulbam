import { afterEach, describe, expect, test, vi } from "vitest";
import { tuneOpusSdp } from "../web/js/call-sdp-tuning.js";
import { createIceCandidateBatcher } from "../web/js/call-signal-batcher.js";
import { computeCallPollingIntervals } from "../web/js/call-polling-policy.js";
import {
  configureAdaptiveBitrate,
  initialBitrateForNetwork,
  markBitrateNetworkRecovered,
  stepAdaptiveBitrateWithStats,
  stopAdaptiveBitrate
} from "../web/js/call-bitrate-controller.js";
import { subscribeRealtime } from "../web/js/shared-realtime.js";

const SAMPLE_OPUS_SDP = [
  "v=0",
  "o=- 12345 2 IN IP4 127.0.0.1",
  "s=-",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=20;usedtx=1",
  "a=rtpmap:0 PCMU/8000",
  ""
].join("\r\n");

describe("Opus SDP tuning (FEC enabled, DTX strictly disabled)", () => {
  test("enables in-band FEC and explicitly forces usedtx=0 even if input had usedtx=1", () => {
    const tuned = tuneOpusSdp(SAMPLE_OPUS_SDP, "normal");
    const fmtp = tuned.split("\r\n").find((line) => line.startsWith("a=fmtp:111 "));
    expect(fmtp).toBeDefined();
    expect(fmtp).toContain("useinbandfec=1");
    expect(fmtp).toContain("usedtx=0");
    expect(fmtp).not.toContain("usedtx=1");
    expect(fmtp).toContain("minptime=10");
    expect(fmtp).toContain("stereo=0");
  });

  test("enables stereo only for music profile while keeping usedtx=0", () => {
    const tuned = tuneOpusSdp(SAMPLE_OPUS_SDP, "music");
    const fmtp = tuned.split("\r\n").find((line) => line.startsWith("a=fmtp:111 "));
    expect(fmtp).toContain("stereo=1");
    expect(fmtp).toContain("sprop-stereo=1");
    expect(fmtp).toContain("maxplaybackrate=48000");
    expect(fmtp).toContain("useinbandfec=1");
    expect(fmtp).toContain("usedtx=0");
  });

  test("inserts a=fmtp line if browser omitted it and leaves non-Opus SDP untouched", () => {
    const withoutFmtp = "v=0\nm=audio 9 RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\n";
    const tuned = tuneOpusSdp(withoutFmtp, "studio");
    expect(tuned).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=0;stereo=0;maxplaybackrate=48000");
    expect(tuneOpusSdp("offer-1", "normal")).toBe("offer-1");
  });
});

describe("ICE candidate batcher", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("batches burst ICE candidates into a single flush and flushes immediately at maxBatch", async () => {
    vi.useFakeTimers();
    const flushed = [];
    const batcher = createIceCandidateBatcher({
      flush: (items) => { flushed.push(items); },
      windowMs: 90,
      maxBatch: 3
    });

    batcher.push({ kind: "ice", payload: { candidate: "c1" } });
    batcher.push({ kind: "ice", payload: { candidate: "c2" } });
    expect(flushed).toHaveLength(0);
    batcher.push({ kind: "ice", payload: { candidate: "c3" } });
    expect(flushed).toHaveLength(1);
    expect(flushed[0].map((item) => item.payload.candidate)).toEqual(["c1", "c2", "c3"]);

    batcher.push({ kind: "ice", payload: { candidate: "c4" } });
    vi.advanceTimersByTime(90);
    expect(flushed).toHaveLength(2);
    expect(flushed[1].map((item) => item.payload.candidate)).toEqual(["c4"]);
  });

  test("clear discards stale queued candidates", () => {
    vi.useFakeTimers();
    const flushed = [];
    const batcher = createIceCandidateBatcher({
      flush: (items) => { flushed.push(items); },
      windowMs: 90,
      maxBatch: 8
    });
    batcher.push({ kind: "ice", payload: { candidate: "stale" } });
    batcher.clear();
    vi.advanceTimersByTime(200);
    expect(flushed).toHaveLength(0);
  });

  test("immediateFirst and isUrgent flush the first candidate and TURN relay candidates at 0ms", () => {
    vi.useFakeTimers();
    const flushed = [];
    const batcher = createIceCandidateBatcher({
      flush: (items) => { flushed.push(items); },
      windowMs: 40,
      maxBatch: 8,
      immediateFirst: true,
      isUrgent: (item) => String(item?.payload?.candidate ?? "").includes(" typ relay ")
    });

    // First candidate flushes immediately without waiting 40 ms.
    batcher.push({ kind: "ice", payload: { candidate: "candidate:1 1 udp 2122260223 10.0.0.1 50000 typ host" } });
    expect(flushed).toHaveLength(1);

    // Subsequent non-relay candidate waits in batch window.
    batcher.push({ kind: "ice", payload: { candidate: "candidate:2 1 udp 1686052607 1.2.3.4 50001 typ srflx" } });
    expect(flushed).toHaveLength(1);

    // Urgent TURN relay candidate flushes immediately together with queued srflx.
    batcher.push({ kind: "ice", payload: { candidate: "candidate:3 1 udp 41885439 5.6.7.8 50002 typ relay raddr 0.0.0.0" } });
    expect(flushed).toHaveLength(2);
    expect(flushed[1]).toHaveLength(2);

    // After clear() (new ICE epoch), leading-edge immediate flush resets.
    batcher.clear();
    batcher.push({ kind: "ice", payload: { candidate: "candidate:4 1 udp 2122260223 10.0.0.2 50003 typ host" } });
    expect(flushed).toHaveLength(3);
  });
});

describe("adaptive call polling cadence", () => {
  test("backs off polling when WebRTC is connected over a live WebSocket", () => {
    expect(computeCallPollingIntervals({
      status: "accepted",
      peerConnected: true,
      realtimeOpen: true,
      recoveryPending: false
    })).toEqual({ signalMs: 15_000, stateMs: 15_000 });
  });

  test("stays aggressive during dialing or when WebSocket/WebRTC is down", () => {
    expect(computeCallPollingIntervals({
      status: "accepted",
      peerConnected: false,
      realtimeOpen: true,
      recoveryPending: false
    })).toEqual({ signalMs: 1_500, stateMs: 2_500 });

    expect(computeCallPollingIntervals({
      status: "accepted",
      peerConnected: true,
      realtimeOpen: false,
      recoveryPending: false
    })).toEqual({ signalMs: 1_500, stateMs: 2_500 });

    expect(computeCallPollingIntervals({
      status: "ringing",
      peerConnected: false,
      realtimeOpen: true,
      recoveryPending: false
    })).toEqual({ signalMs: null, stateMs: 4_000 });
  });
});

describe("poor-network adaptive bitrate and unified stats stepping", () => {
  test("starts conservatively on 2g or high-RTT cellular networks", () => {
    expect(initialBitrateForNetwork({ maxBitrate: 64_000 }, { effectiveType: "2g", rtt: 400 })).toBe(32_000);
    expect(initialBitrateForNetwork({ maxBitrate: 64_000 }, { effectiveType: "4g", rtt: 80 })).toBe(64_000);
  });

  test("steps bitrate using shared stats without creating a second timer and recovers smoothly", async () => {
    let appliedBitrate = null;
    const sender = {
      track: { kind: "audio", readyState: "live" },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async (params) => { appliedBitrate = params.encodings[0].maxBitrate; }),
      getStats: vi.fn(async () => new Map())
    };

    const profile = { maxBitrate: 64_000 };
    await configureAdaptiveBitrate(sender, profile, {
      managedExternally: true,
      connection: { effectiveType: "4g", rtt: 60 }
    });
    expect(appliedBitrate).toBe(64_000);
    expect(sender.getStats).not.toHaveBeenCalled();

    const severeStats = new Map([["r", { type: "remote-inbound-rtp", kind: "audio", fractionLost: 0.12, roundTripTime: 0.55 }]]);
    await stepAdaptiveBitrateWithStats(sender, profile, severeStats);
    expect(appliedBitrate).toBe(38_000);

    markBitrateNetworkRecovered(sender);
    const goodStats = new Map([["r", { type: "remote-inbound-rtp", kind: "audio", fractionLost: 0.002, roundTripTime: 0.08 }]]);
    await stepAdaptiveBitrateWithStats(sender, profile, goodStats);
    expect(appliedBitrate).toBe(38_000);
    await stepAdaptiveBitrateWithStats(sender, profile, goodStats);
    expect(appliedBitrate).toBe(45_000);

    stopAdaptiveBitrate(sender);
  });
});

describe("shared realtime zombie-socket watchdog", () => {
  const originalSocket = globalThis.WebSocket;
  const originalLocation = globalThis.location;

  afterEach(() => {
    globalThis.WebSocket = originalSocket;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    vi.useRealTimers();
  });

  test("closes a silent zombie socket after pong timeout and suppresses pong events from listeners", () => {
    vi.useFakeTimers();
    class FakeSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances = [];
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        FakeSocket.instances.push(this);
      }
      addEventListener(name, cb) {
        const list = this.listeners.get(name) ?? [];
        list.push(cb);
        this.listeners.set(name, list);
      }
      emit(name, event = {}) {
        for (const cb of this.listeners.get(name) ?? []) cb(event);
      }
      open() { this.readyState = 1; this.emit("open"); }
      send(text) { this.sent.push(text); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    }

    globalThis.WebSocket = FakeSocket;
    globalThis.location = { protocol: "https:", host: "bulbam.test" };
    const received = [];
    const unsubscribe = subscribeRealtime("parking-user", {
      message: (payload) => received.push(payload)
    });

    const first = FakeSocket.instances[0];
    first.open();

    // First ping receives a valid pong -> socket stays healthy and listeners ignore pong.
    vi.advanceTimersByTime(25_000);
    expect(first.sent).toEqual(["ping"]);
    first.emit("message", { data: JSON.stringify({ type: "pong", at: Date.now() }) });
    vi.advanceTimersByTime(10_000);
    expect(first.readyState).toBe(1);
    expect(received).toEqual([]);

    // Next ping gets no pong (half-open cellular socket in parking garage) -> watchdog closes & reconnects.
    vi.advanceTimersByTime(15_000);
    expect(first.sent).toEqual(["ping", "ping"]);
    vi.advanceTimersByTime(8_000);
    expect(first.readyState).toBe(3);

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    unsubscribe();
  });
});
