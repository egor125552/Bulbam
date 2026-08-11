import { afterEach, expect, test, vi } from "vitest";

class EventHub {
  constructor() { this.listeners = new Map(); }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeElement extends EventHub {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.srcObject = null;
    this.value = "";
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) listener({ type: "click" });
  }

  focus() {}
  replaceChildren() {}
  play() { return Promise.resolve(); }
}

class FakeDocument extends EventHub {
  constructor() {
    super();
    this.visibilityState = "visible";
    this.elements = new Map();
  }

  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new FakeElement());
    return this.elements.get(selector);
  }
}

class FakeWebSocket extends EventHub {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];

  constructor() {
    super();
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send() {}

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
}

class FakePeerConnection extends EventHub {
  static instances = [];

  constructor(configuration) {
    super();
    this.configuration = configuration;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.createOfferOptions = [];
    this.restartIceCalls = 0;
    this.closed = false;
    this.statsPackets = 100;
    this.receiver = { track: { kind: "audio" }, jitterBufferTarget: null };
    FakePeerConnection.instances.push(this);
  }

  addTrack(track) {
    return {
      track,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {}
    };
  }

  async createOffer(options = {}) {
    this.createOfferOptions.push(options);
    return { type: "offer", sdp: `offer-${this.createOfferOptions.length}` };
  }

  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate() {}
  getConfiguration() { return this.configuration; }
  setConfiguration(configuration) { this.configuration = configuration; }
  restartIce() { this.restartIceCalls += 1; }
  getReceivers() { return [this.receiver]; }

  async getStats() {
    this.statsPackets += 20;
    return new Map([["audio", {
      id: "audio",
      type: "inbound-rtp",
      kind: "audio",
      packetsReceived: this.statsPackets,
      packetsLost: 0,
      jitter: 0.005
    }]]);
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
  }

  emitConnection(state, ice = state === "connected" ? "connected" : state) {
    this.connectionState = state;
    this.iceConnectionState = ice;
    for (const listener of this.listeners.get("connectionstatechange") ?? []) listener({});
    for (const listener of this.listeners.get("iceconnectionstatechange") ?? []) listener({});
  }
}

const originalGlobals = new Map();

function replaceGlobal(name, value) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals() {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  originalGlobals.clear();
}

async function flushAsync(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreGlobals();
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
});

test("audio calls buffer short drops, soft-restart ICE, then rebuild with fresh TURN routes", async () => {
  vi.useFakeTimers();

  const document = new FakeDocument();
  const window = new EventHub();
  const announcements = [];
  const signalBodies = [];
  let signalSequence = 0;
  let iceFetches = 0;
  let serverStatus = "ringing";

  const call = {
    callId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    status: "ringing",
    direction: "outgoing",
    peer: { userId: "beta", username: "beta", displayName: "Бета" }
  };

  const conversationPeer = document.querySelector("#conversation-peer");
  conversationPeer.textContent = "@beta";
  document.querySelector("#message-form").hidden = false;
  document.querySelector("#live-status").textContent = "";

  const track = {
    kind: "audio",
    enabled: true,
    label: "Test microphone",
    contentHint: "",
    stop() {},
    async applyConstraints() {},
    getSettings: () => ({
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    })
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  };

  const fakeFetch = vi.fn(async (input, options = {}) => {
    const path = typeof input === "string" ? input : input.url;
    let status = 200;
    let payload;

    if (path === "/api/v1/chats") {
      payload = { chats: [{ conversationId: call.conversationId, peer: call.peer }] };
    } else if (path === `/api/v1/chats/${call.conversationId}/calls` && options.method === "POST") {
      status = 201;
      payload = { call: { ...call } };
    } else if (path === "/api/v1/calls/ice") {
      iceFetches += 1;
      payload = { iceServers: [{ urls: [`turn:turn-${iceFetches}.test:3478`] }] };
    } else if (path.endsWith("/signals") && options.method === "POST") {
      const body = JSON.parse(options.body);
      signalBodies.push(body);
      payload = { signal: { sequence: ++signalSequence, ...body } };
      status = 201;
    } else if (path.includes("/signals?after=")) {
      payload = { signals: [] };
    } else if (path.endsWith("/end") && options.method === "POST") {
      serverStatus = "ended";
      payload = { call: { ...call, status: "ended" } };
    } else if (path.includes(`/calls/${call.callId}`)) {
      payload = { call: { ...call, status: serverStatus } };
    } else {
      throw new Error(`Unexpected request: ${options.method ?? "GET"} ${path}`);
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    });
  });

  replaceGlobal("window", window);
  replaceGlobal("document", document);
  replaceGlobal("CustomEvent", class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  });
  replaceGlobal("MutationObserver", class { observe() {} });
  replaceGlobal("navigator", {
    mediaDevices: {
      getSupportedConstraints: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: true,
        sampleRate: true,
        sampleSize: true
      }),
      getUserMedia: async () => stream
    }
  });
  replaceGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {}
  });
  replaceGlobal("location", { protocol: "https:", host: "bulbam.test", href: "https://bulbam.test/" });
  replaceGlobal("history", { replaceState() {} });
  replaceGlobal("MediaStream", class { constructor(tracks = []) { this.tracks = tracks; } });
  replaceGlobal("WebSocket", FakeWebSocket);
  replaceGlobal("RTCPeerConnection", FakePeerConnection);
  replaceGlobal("fetch", fakeFetch);

  const { setupCalls } = await import("../web/js/calls.js");
  const { elements } = await import("../web/js/ui.js");
  const originalLiveStatusDescriptor = Object.getOwnPropertyDescriptor(elements.liveStatus, "textContent");
  let liveStatusText = elements.liveStatus.textContent;
  Object.defineProperty(elements.liveStatus, "textContent", {
    configurable: true,
    get: () => liveStatusText,
    set: (value) => { liveStatusText = value; announcements.push(value); }
  });

  setupCalls();
  window.dispatchEvent(new CustomEvent("bulbam:account-changed", { detail: { account: { userId: "alpha" } } }));
  await flushAsync();

  elements.callStartButton.click();
  await flushAsync();
  expect(FakeWebSocket.instances).toHaveLength(1);

  serverStatus = "accepted";
  FakeWebSocket.instances[0].emit("message", {
    data: JSON.stringify({ type: "call.answered", callId: call.callId, answeredAt: Date.now() })
  });
  await flushAsync();

  expect(FakePeerConnection.instances).toHaveLength(1);
  const first = FakePeerConnection.instances[0];
  expect(signalBodies.filter((signal) => signal.kind === "offer")).toHaveLength(1);

  first.emitConnection("connected");
  await flushAsync();
  first.emitConnection("failed", "failed");
  await flushAsync();

  expect(FakePeerConnection.instances).toHaveLength(1);
  expect(first.restartIceCalls).toBeGreaterThanOrEqual(1);
  expect(iceFetches).toBeGreaterThanOrEqual(2);
  expect(signalBodies.filter((signal) => signal.kind === "offer").at(-1).payload.recoveryMode).toBe("ice-restart");
  expect(first.receiver.jitterBufferTarget).toBe(300);

  first.emitConnection("connected", "connected");
  await vi.advanceTimersByTimeAsync(16_500);
  expect(FakePeerConnection.instances).toHaveLength(1);
  expect(first.receiver.jitterBufferTarget).toBeNull();

  const offersBeforeShortDrop = signalBodies.filter((signal) => signal.kind === "offer").length;
  first.emitConnection("disconnected", "disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  first.emitConnection("connected", "connected");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(signalBodies.filter((signal) => signal.kind === "offer")).toHaveLength(offersBeforeShortDrop);

  first.emitConnection("failed", "failed");
  await flushAsync();
  await vi.advanceTimersByTimeAsync(7_100);
  await flushAsync();

  expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(2);
  const second = FakePeerConnection.instances.at(-1);
  expect(first.closed).toBe(true);
  expect(signalBodies.filter((signal) => signal.kind === "offer").at(-1).payload.recoveryMode).toBe("rebuild");

  second.emitConnection("connected", "connected");
  await flushAsync();
  expect(announcements).toContain("Связь восстановлена. Разговор продолжается.");

  elements.callEndButton.click();
  await flushAsync();
  vi.clearAllTimers();

  if (originalLiveStatusDescriptor) {
    Object.defineProperty(elements.liveStatus, "textContent", originalLiveStatusDescriptor);
  } else {
    delete elements.liveStatus.textContent;
  }
});
