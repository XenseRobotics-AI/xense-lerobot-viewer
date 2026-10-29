/** Fixed UTC+8 timestamps, independent of the server/browser timezone. */
export const REVIEW_TIME_ZONE = "Asia/Shanghai";

export function reviewTimestamp(input: string | Date = new Date()): string {
  const time = input instanceof Date ? input.getTime() : Date.parse(input);
  if (!Number.isFinite(time)) throw new Error("Invalid review timestamp");
  return new Date(time + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/, "+08:00");
}
