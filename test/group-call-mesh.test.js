import { describe, expect, test } from "vitest";
import {
  shouldInitiateOffer,
  reconcileMeshPeers,
  formatParticipantCount,
  buildGroupCallBannerText,
  formatParticipantStatus
} from "../web/js/group-call-mesh.js";

describe("group call pure mesh helpers", () => {
  test("shouldInitiateOffer is strictly asymmetric and glare-free", () => {
    const a = "00000000-0000-0000-0000-000000000001";
    const b = "00000000-0000-0000-0000-000000000002";
    expect(shouldInitiateOffer(a, b)).toBe(true);
    expect(shouldInitiateOffer(b, a)).toBe(false);
    expect(shouldInitiateOffer(a, a)).toBe(false);
    expect(shouldInitiateOffer("", b)).toBe(false);
  });

  test("reconcileMeshPeers connects new peers with deterministic offer side and removes departed peers", () => {
    const participants = [
      { userId: "u2", displayName: "Я" },
      { userId: "u1", displayName: "Аня" },
      { userId: "u4", displayName: "Борис" }
    ];
    const diff = reconcileMeshPeers("u2", participants, ["u1", "u3"]);
    expect(diff.toConnect).toEqual([
      {
        userId: "u4",
        shouldOffer: true,
        participant: { userId: "u4", displayName: "Борис" }
      }
    ]);
    expect(diff.toRemove).toEqual(["u3"]);
  });

  test("formatParticipantCount handles Russian plural rules", () => {
    expect(formatParticipantCount(1)).toBe("1 участник");
    expect(formatParticipantCount(2)).toBe("2 участника");
    expect(formatParticipantCount(4)).toBe("4 участника");
    expect(formatParticipantCount(5)).toBe("5 участников");
    expect(formatParticipantCount(11)).toBe("11 участников");
    expect(formatParticipantCount(21)).toBe("21 участник");
  });

  test("buildGroupCallBannerText formats active participant counts", () => {
    expect(buildGroupCallBannerText({ participants: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }, { userId: "u4" }] }))
      .toBe("Идёт групповой звонок · 4 участника");
    expect(buildGroupCallBannerText({ participantCount: 1 }))
      .toBe("Идёт групповой звонок · 1 участник");
    expect(buildGroupCallBannerText({ participantCount: 0 }))
      .toBe("Идёт групповой звонок");
  });

  test("formatParticipantStatus describes local and remote mute/connection states", () => {
    expect(formatParticipantStatus({ displayName: "Егор", muted: true, isSelf: true }))
      .toBe("Егор (вы) — микрофон выключен");
    expect(formatParticipantStatus({ displayName: "Егор", muted: false, isSelf: true }))
      .toBe("Егор (вы) — микрофон включён");
    expect(formatParticipantStatus({ displayName: "Настя", muted: false, isSelf: false, connectionState: "connected" }))
      .toBe("Настя — на связи");
    expect(formatParticipantStatus({ displayName: "Настя", muted: true, isSelf: false, connectionState: "connected" }))
      .toBe("Настя — на связи, микрофон выключен");
    expect(formatParticipantStatus({ displayName: "Дима", muted: false, isSelf: false, connectionState: "disconnected" }))
      .toBe("Дима — переподключается");
    expect(formatParticipantStatus({ displayName: "Дима", muted: false, isSelf: false, connectionState: "connecting" }))
      .toBe("Дима — соединяется");
  });
});
