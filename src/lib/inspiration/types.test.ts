import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RoomType } from "../../schemas/generated/types/roomType.js";
import { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import { TOOL_TYPE_KEYS } from "../taxonomy/registry.js";
import {
  ROOM_TYPE_VALUES,
  DESIGN_STYLE_VALUES,
  TOOL_TYPE_VALUES,
} from "./types.js";

// Drift guard: these explore value sets must stay identical to their canonical
// sources. Because they are *derived* (Object.values / TOOL_TYPE_KEYS) the
// equality is structural, but this test documents the contract and fails loudly
// if someone reintroduces a hand-copied literal that diverges.
describe("explore taxonomy values — parity with canonical sources", () => {
  it("ROOM_TYPE_VALUES equals Object.values(RoomType)", () => {
    assert.deepEqual([...ROOM_TYPE_VALUES], Object.values(RoomType));
  });

  it("DESIGN_STYLE_VALUES equals Object.values(DesignStyle)", () => {
    assert.deepEqual([...DESIGN_STYLE_VALUES], Object.values(DesignStyle));
  });

  it("TOOL_TYPE_VALUES equals the registry TOOL_TYPE_KEYS", () => {
    assert.deepEqual([...TOOL_TYPE_VALUES], [...TOOL_TYPE_KEYS]);
  });

  it("no value set is empty (z.enum tuple requirement holds)", () => {
    assert.ok(ROOM_TYPE_VALUES.length > 0);
    assert.ok(DESIGN_STYLE_VALUES.length > 0);
    assert.ok(TOOL_TYPE_VALUES.length > 0);
  });
});
