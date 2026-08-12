export const DISPLAY_LOCALE = "zh-CN";
export const DISPLAY_TIME_ZONE = "Asia/Shanghai";
export const DISPLAY_TIME_ZONE_LABEL = "UTC+8/CST";

const formatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

/** Formats an API UTC instant for every user-visible CourseForge timestamp. */
export function formatShanghaiDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return `时间未知 · ${DISPLAY_TIME_ZONE_LABEL}`;
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second} · ${DISPLAY_TIME_ZONE_LABEL}`;
}
