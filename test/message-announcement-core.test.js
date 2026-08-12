import { describe, expect, test } from "vitest";
import { findNewIncomingMessages } from "../web/js/message-announcement-core.js";

const ACCOUNT_ID = "user-me";

function message(messageId, senderUserId) {
  return { messageId, senderUserId };
}

describe("fallback message announcements", () => {
  test("finds a new incoming message that was not in the known history", () => {
    const known = new Set(["old-1"]);
    const result = findNewIncomingMessages(known, [
      message("old-1", "user-peer"),
      message("new-1", "user-peer")
    ], ACCOUNT_ID);

    expect(result.map((item) => item.messageId)).toEqual(["new-1"]);
  });

  test("does not announce the current user's own new server message", () => {
    const result = findNewIncomingMessages(new Set(), [
      message("mine-1", ACCOUNT_ID)
    ], ACCOUNT_ID);

    expect(result).toEqual([]);
  });

  test("does not announce a realtime message already remembered from the visible DOM", () => {
    const known = new Set(["realtime-1"]);
    const result = findNewIncomingMessages(known, [
      message("realtime-1", "user-peer")
    ], ACCOUNT_ID);

    expect(result).toEqual([]);
  });
});
