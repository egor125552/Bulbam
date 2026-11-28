import { describe, expect, test } from "vitest";
import {
  createCallProfiler,
  formatCallProfileCompact,
  formatCallProfileReport
} from "../web/js/call-profiler.js";

describe("call connection profiler", () => {
  test("measures incoming call milestones, phase spans, batcher hold time, and ranks top bottlenecks", () => {
    let clock = 1000;
    const profiler = createCallProfiler({ now: () => clock });
    const sid = profiler.start("incoming", { kind: "direct" });

    // Sequential microphone acquisition before /answer
    profiler.mark("mic_start", sid);
    clock += 240;
    profiler.mark("mic_ready", sid);

    // Parallel /answer HTTP + PC creation
    profiler.mark("answer_http_start", sid);
    profiler.mark("pc_create_start", sid);
    profiler.setMeta({ iceCacheHit: true, iceHasTurn: true }, sid);
    clock += 35;
    profiler.mark("pc_created", sid);
    clock += 65; // 100 ms total for /answer HTTP
    profiler.mark("answer_http_done", sid);

    // Wasted wait for caller's SDP offer (round trip)
    clock += 290;
    profiler.mark("offer_received", sid);
    clock += 12;
    profiler.mark("offer_remote_set", sid);
    profiler.mark("answer_create_start", sid);
    clock += 18;
    profiler.mark("answer_local_set", sid);
    profiler.mark("first_local_ice", sid, { meta: "srflx" });
    profiler.setMeta({ firstLocalIceType: "srflx" }, sid);
    profiler.mark("answer_send_start", sid);
    clock += 90;
    profiler.mark("answer_sent", sid);
    profiler.mark("first_ice_flush_start", sid, { meta: "3" });
    profiler.setMeta({ firstIceBatchSize: 3 }, sid);
    clock += 55;
    profiler.mark("first_ice_flush_done", sid);
    profiler.mark("ice_checking", sid);
    clock += 120;
    profiler.mark("ice_connected", sid);
    profiler.mark("pc_connecting", sid);
    clock += 145;
    profiler.mark("pc_connected", sid);
    clock += 45;
    profiler.setMeta({ route: "direct", rttMs: 38.4 }, sid);
    profiler.mark("first_audio_frame", sid);

    const profile = profiler.getLatest();
    expect(profile.direction).toBe("incoming");
    expect(profile.status).toBe("connected");
    expect(profile.totalConnectMs).toBe(1070);
    expect(profile.totalToFirstAudioMs).toBe(1115);
    expect(profile.spans.micMs).toBe(240);
    expect(profile.spans.answerHttpMs).toBe(100);
    expect(profile.spans.pcCreateMs).toBe(35);
    expect(profile.spans.waitForOfferMs).toBe(290);
    expect(profile.spans.firstIceBatchHoldMs).toBe(90);
    expect(profile.spans.iceCheckMs).toBe(120);
    expect(profile.spans.dtlsHandshakeMs).toBe(145);
    expect(profile.spans.firstAudioAfterConnectMs).toBe(45);
    expect(profile.meta.rttMs).toBe(38);
    expect(profile.meta.route).toBe("direct");

    // Top bottlenecks sorted descending
    expect(profile.bottlenecks[0].key).toBe("waitForOfferMs");
    expect(profile.bottlenecks[0].ms).toBe(290);
    expect(profile.bottlenecks[1].key).toBe("micMs");
    expect(profile.bottlenecks[1].ms).toBe(240);

    const report = formatCallProfileReport(profile);
    expect(report).toContain("Итого до WebRTC connected: 1070 мс.");
    expect(report).toContain("Итого до первого аудиопакета: 1115 мс.");
    expect(report).toContain("Главные задержки:");
    expect(report).toContain("Ожидание SDP offer от звонящего: 290 мс");
    expect(report).toContain("Задержка первой пачки ICE в батчере: 90 мс");

    const compact = formatCallProfileCompact(profile);
    expect(compact).toBe("всего 1070ms, аудио 1115ms, direct, waitForOfferMs=290ms");
  });

  test("anchors outgoing call total connect time at call_answered rather than ringing duration", () => {
    let clock = 5000;
    const profiler = createCallProfiler({ now: () => clock });
    const sid = profiler.start("outgoing", { kind: "direct" });

    profiler.mark("mic_start", sid);
    clock += 180;
    profiler.mark("mic_ready", sid);
    profiler.mark("call_create_start", sid);
    clock += 90;
    profiler.mark("call_create_done", sid);
    profiler.mark("prewarm_pc_ready", sid);

    // Peer rings for 6.5 seconds before answering
    clock += 6500;
    profiler.setMeta({ answerSource: "ws" }, sid);
    profiler.mark("call_answered", sid, { meta: "ws" });

    profiler.mark("offer_create_start", sid);
    clock += 20;
    profiler.mark("offer_local_set", sid);
    profiler.mark("offer_send_start", sid);
    clock += 80;
    profiler.mark("offer_sent", sid);
    clock += 210;
    profiler.mark("answer_received", sid);
    clock += 15;
    profiler.mark("answer_remote_set", sid);
    profiler.mark("ice_checking", sid);
    clock += 110;
    profiler.mark("ice_connected", sid);
    clock += 125;
    profiler.mark("pc_connected", sid);

    const profile = profiler.getLatest();
    expect(profile.ringingWaitMs).toBe(6500);
    // Total connect excludes the 6.5s ringing wait and pre-ring mic/HTTP time!
    expect(profile.totalConnectMs).toBe(560);
    expect(profile.spans.waitForAnswerMs).toBe(210);
    // Pre-answer milestones have negative offsets relative to call_answered
    const startEvent = profile.timeline.find((e) => e.stage === "start_clicked");
    expect(startEvent.fromAnchorMs).toBe(-6770);
  });

  test("ignores stale session marks and strips unsafe metadata", () => {
    let clock = 0;
    const profiler = createCallProfiler({ now: () => clock });
    const first = profiler.start("incoming");
    clock += 100;
    const second = profiler.start("outgoing");
    clock += 50;

    // Late mark from first call must not corrupt second call
    expect(profiler.mark("pc_connected", first)).toBe(false);
    expect(profiler.getLatest().id).toBe(second);
    expect(profiler.getLatest().status).toBe("in_progress");

    // Unsafe SDP/IP/whitespace metadata must be stripped
    profiler.mark("first_local_ice", second, { meta: "192.168.1.1 secret token" });
    const iceEvent = profiler.getLatest().timeline.find((e) => e.stage === "first_local_ice");
    expect(iceEvent.meta).toBeNull();
  });

  test("excludes ringing wait from waitForAnswerMs and hides pre-ringing spans from post-answer bottlenecks", () => {
    let clock = 10_000;
    const profiler = createCallProfiler({ now: () => clock });
    const sid = profiler.start("outgoing", { kind: "direct" });

    // Caller creates and uploads pre-offer during ringing
    profiler.mark("call_create_start", sid);
    clock += 400;
    profiler.mark("call_create_done", sid);
    profiler.mark("offer_create_start", sid);
    clock += 60;
    profiler.mark("offer_local_set", sid);
    profiler.mark("offer_send_start", sid);
    clock += 500;
    profiler.mark("offer_sent", sid);

    // Callee rings for 7 seconds before answering
    clock += 7_000;
    profiler.mark("call_answered", sid, { meta: "ws" });

    // Answer arrives 520 ms after callee pressed Answer
    clock += 520;
    profiler.mark("answer_received", sid);
    clock += 10;
    profiler.mark("answer_remote_set", sid);
    profiler.mark("ice_checking", sid);
    clock += 350;
    profiler.mark("ice_connected", sid);
    clock += 90;
    profiler.mark("pc_connected", sid);

    const profile = profiler.getLatest();
    expect(profile.totalConnectMs).toBe(970);
    // Must measure 520 ms from call_answered, NOT 7520 ms from pre-offer offer_sent!
    expect(profile.spans.waitForAnswerMs).toBe(520);
    // Pre-ringing offerSendHttpMs (500 ms) finished before call_answered and must not pollute bottlenecks.
    const bottleneckKeys = profile.bottlenecks.map((item) => item.key);
    expect(bottleneckKeys).not.toContain("offerSendHttpMs");
    expect(bottleneckKeys[0]).toBe("waitForAnswerMs");
  });
});
