import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOLIDAYS_2026, isPeak, parsePeakWindows } from "../lib/time.js";

const policy = { timeZone: "Asia/Shanghai", windows: ["09:00-12:00", "14:00-18:00"], holidays: DEFAULT_HOLIDAYS_2026 };
const at = (iso) => Date.parse(iso);

test("weekday peak windows are 09-12 and 14-18, lunch is off-peak", () => {
  assert.equal(isPeak(at("2026-10-30T01:00:00Z"), policy), true); // 09:00
  assert.equal(isPeak(at("2026-10-30T03:59:00Z"), policy), true); // 11:59
  assert.equal(isPeak(at("2026-10-30T04:00:00Z"), policy), false); // 12:00
  assert.equal(isPeak(at("2026-10-30T05:59:00Z"), policy), false); // 13:59
  assert.equal(isPeak(at("2026-10-30T06:00:00Z"), policy), true); // 14:00
  assert.equal(isPeak(at("2026-10-30T09:59:00Z"), policy), true); // 17:59
  assert.equal(isPeak(at("2026-10-30T10:00:00Z"), policy), false); // 18:00
});

test("weekends and 2026 statutory holidays are off-peak", () => {
  assert.equal(isPeak(at("2026-10-31T02:00:00Z"), policy), false); // Saturday 10:00
  assert.equal(isPeak(at("2026-11-01T02:00:00Z"), policy), false); // Sunday 10:00
  assert.equal(isPeak(at("2026-10-01T02:00:00Z"), policy), false); // National Day
  assert.equal(isPeak(at("2026-02-17T02:00:00Z"), policy), false); // Spring Festival
  assert.equal(isPeak(at("2026-10-29T11:00:00Z"), policy), false); // Thursday 19:00
});

test("parses windows and falls back to defaults on malformed input", () => {
  assert.deepEqual(parsePeakWindows(["09:00-12:00", "14:00-18:00"]), [[540, 720], [840, 1080]]);
  assert.deepEqual(parsePeakWindows(["bad"]).length, 2);
});
