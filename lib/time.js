/**
 * Beijing-time peak/off-peak policy.
 *
 * Peak: Monday-Friday, excluding Chinese statutory holidays,
 *       09:00-12:00 and 14:00-18:00 Asia/Shanghai.
 * Everything else (lunch, nights, weekends, holidays) is off-peak.
 *
 * 2026 holiday dates come from the State Council notice
 * 国办发明电〔2025〕7号. 2027 is intentionally not guessed; update the
 * `holidays` config after the official notice is published.
 */

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_PEAK_WINDOWS = ["09:00-12:00", "14:00-18:00"];

export const DEFAULT_HOLIDAYS_2026 = Object.freeze([
  // 元旦
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07",
]);

/** Parse "09:00-12:00" strings into minute ranges. */
export function parsePeakWindows(values = DEFAULT_PEAK_WINDOWS) {
  const result = [];
  for (const value of values) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/u.exec(String(value).trim());
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end > start) result.push([start, end]);
  }
  return result.length > 0 ? result : parsePeakWindows(DEFAULT_PEAK_WINDOWS);
}

/** Beijing calendar parts for one instant. */
export function beijingParts(now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * @param {number} now epoch milliseconds
 * @param {{timeZone?:string, windows?:string[], holidays?:string[]}} policy
 * @returns {boolean} true during a weekday peak window, excluding holidays
 */
export function isPeak(now = Date.now(), policy = {}) {
  const parts = beijingParts(now, policy.timeZone ?? DEFAULT_TIME_ZONE);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const holidays = Array.isArray(policy.holidays) ? policy.holidays : DEFAULT_HOLIDAYS_2026;
  if (holidays.includes(parts.date)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return parsePeakWindows(policy.windows ?? DEFAULT_PEAK_WINDOWS).some(([start, end]) => minutes >= start && minutes < end);
}

/** Human-readable next boundary for the status bar (best effort, no holiday calendar search). */
export function describePeak(now = Date.now(), policy = {}) {
  const peak = isPeak(now, policy);
  const parts = beijingParts(now, policy.timeZone ?? DEFAULT_TIME_ZONE);
  const minutes = parts.hour * 60 + parts.minute;
  const windows = parsePeakWindows(policy.windows ?? DEFAULT_PEAK_WINDOWS);
  let next = null;
  if (!peak) {
    const today = windows.find(([start]) => minutes < start);
    if (today) next = `${String(Math.floor(today[0] / 60)).padStart(2, "0")}:${String(today[0] % 60).padStart(2, "0")}`;
  } else {
    const current = windows.find(([start, end]) => minutes >= start && minutes < end);
    if (current) next = `${String(Math.floor(current[1] / 60)).padStart(2, "0")}:${String(current[1] % 60).padStart(2, "0")}`;
  }
  return { peak, next, date: parts.date, weekday: parts.weekday };
}
