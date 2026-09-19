export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
export function activeStreak(
  streakDays: number,
  lastSolvedDay: string | undefined,
  today = utcDay(),
): number {
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return lastSolvedDay === today || lastSolvedDay === utcDay(yesterday) ? streakDays : 0;
}
