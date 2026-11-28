import { describe, expect, test } from "vitest";
import {
  createGroupCallPickerState,
  formatCallPickerCount,
  formatCallPickerSubmitLabel,
  normalizeCallCandidates
} from "../web/js/group-call-picker.js";

describe("group call participant picker state", () => {
  const members = [
    { userId: "u-self", user: { userId: "u-self", username: "egor", displayName: "Егор" } },
    { userId: "u-bob", user: { userId: "u-bob", username: "bob", displayName: "Боб" } },
    { userId: "u-carol", user: { userId: "u-carol", username: "carol", displayName: "Катя" } },
    { userId: "u-bob", user: { userId: "u-bob", username: "bob", displayName: "Боб Дубль" } }
  ];

  test("excludes current user and deduplicates group members", () => {
    const list = normalizeCallCandidates(members, "u-self");
    expect(list).toEqual([
      { userId: "u-bob", username: "bob", displayName: "Боб" },
      { userId: "u-carol", username: "carol", displayName: "Катя" }
    ]);
  });

  test("starts empty with canCall=false and toggles call availability strictly with selection", () => {
    const picker = createGroupCallPickerState(members, "u-self");
    expect(picker.snapshot()).toMatchObject({
      selectedIds: [],
      selectedCount: 0,
      canCall: false,
      allSelected: false
    });

    // Unknown member is ignored
    expect(picker.toggle("u-unknown").canCall).toBe(false);

    // Select Bob -> canCall becomes true
    expect(picker.toggle("u-bob")).toMatchObject({
      selectedIds: ["u-bob"],
      selectedCount: 1,
      canCall: true,
      allSelected: false
    });

    // Unselect Bob -> canCall returns to false
    expect(picker.toggle("u-bob")).toMatchObject({
      selectedIds: [],
      selectedCount: 0,
      canCall: false,
      allSelected: false
    });

    // toggleAll selects everyone, second toggleAll clears selection
    expect(picker.toggleAll()).toMatchObject({
      selectedIds: ["u-bob", "u-carol"],
      selectedCount: 2,
      canCall: true,
      allSelected: true
    });
    expect(picker.toggleAll()).toMatchObject({
      selectedIds: [],
      selectedCount: 0,
      canCall: false,
      allSelected: false
    });
  });

  test("drops removed members from selection when member list refreshes", () => {
    const picker = createGroupCallPickerState(members, "u-self");
    picker.selectAll();
    const updated = picker.setMembers([members[0], members[2]]);
    expect(updated.selectedIds).toEqual(["u-carol"]);
    expect(updated.allSelected).toBe(true);
  });

  test("formats Russian count and call submit labels cleanly", () => {
    expect(formatCallPickerCount(0)).toBe("Никто не выбран");
    expect(formatCallPickerCount(1)).toBe("Выбрано: 1 участник");
    expect(formatCallPickerCount(2)).toBe("Выбрано: 2 участника");
    expect(formatCallPickerCount(5)).toBe("Выбрано: 5 участников");
    expect(formatCallPickerSubmitLabel(0)).toBe("Позвонить");
    expect(formatCallPickerSubmitLabel(3)).toBe("Позвонить (3)");
  });
});
