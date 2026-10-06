// The renderer's single business time zone, passed in by the main process
// (env.businessTimeZone). Displayed times and day labels follow it.
export const businessTimeZone = () => window.taskpilot.businessTimeZone;

// YYYY-MM-DD of `date` in the business time zone.
export const businessDay = (date: Date, timeZone = businessTimeZone()) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// The business day before `day` (YYYY-MM-DD); noon UTC avoids DST edges.
export const previousDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
