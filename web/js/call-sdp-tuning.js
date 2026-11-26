// Pure SDP tuning for resilient Opus calls on poor mobile networks.
// Enables in-band FEC for packet-loss resilience without ever enabling DTX
// (continuous audio comfort is preserved per user requirement).

export function tuneOpusSdp(sdp, profileId = "normal") {
  if (typeof sdp !== "string" || !sdp.trim()) return sdp;

  const lineEnding = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);

  const opusPayloadTypes = new Set();
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?$/i.exec(line.trim());
    if (match) opusPayloadTypes.add(match[1]);
  }
  if (!opusPayloadTypes.size) return sdp;

  const isMusic = profileId === "music";
  const isStudio = profileId === "studio";
  const desiredParams = new Map([
    ["minptime", "10"],
    ["useinbandfec", "1"],
    ["usedtx", "0"]
  ]);
  if (isMusic) {
    desiredParams.set("stereo", "1");
    desiredParams.set("sprop-stereo", "1");
    desiredParams.set("maxplaybackrate", "48000");
  } else if (isStudio) {
    desiredParams.set("stereo", "0");
    desiredParams.set("maxplaybackrate", "48000");
  } else {
    desiredParams.set("stereo", "0");
    desiredParams.set("sprop-stereo", "0");
  }

  const seenFmtp = new Set();
  const updated = lines.map((line) => {
    const match = /^a=fmtp:(\d+)\s+(.*)$/i.exec(line);
    if (!match || !opusPayloadTypes.has(match[1])) return line;
    const pt = match[1];
    seenFmtp.add(pt);
    const params = parseFmtpParams(match[2]);
    for (const [key, value] of desiredParams) {
      params.set(key, value);
    }
    return `a=fmtp:${pt} ${formatFmtpParams(params)}`;
  });

  // If the browser omitted an a=fmtp line for Opus, insert one right after its rtpmap.
  if (seenFmtp.size < opusPayloadTypes.size) {
    const out = [];
    for (const line of updated) {
      out.push(line);
      const match = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?$/i.exec(line.trim());
      if (match && opusPayloadTypes.has(match[1]) && !seenFmtp.has(match[1])) {
        seenFmtp.add(match[1]);
        out.push(`a=fmtp:${match[1]} ${formatFmtpParams(desiredParams)}`);
      }
    }
    return out.join(lineEnding);
  }

  return updated.join(lineEnding);
}

function parseFmtpParams(raw) {
  const map = new Map();
  for (const part of String(raw || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      map.set(trimmed.toLowerCase(), "");
    } else {
      const key = trimmed.slice(0, eq).trim().toLowerCase();
      const value = trimmed.slice(eq + 1).trim();
      if (key) map.set(key, value);
    }
  }
  return map;
}

function formatFmtpParams(map) {
  const parts = [];
  for (const [key, value] of map.entries()) {
    parts.push(value === "" ? key : `${key}=${value}`);
  }
  return parts.join(";");
}
