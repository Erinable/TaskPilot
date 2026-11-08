// The renderer's single business time zone, passed in by the main process
// (env.businessTimeZone). Displayed times and day labels follow it.
export const businessTimeZone = () => window.taskpilot.businessTimeZone;

// Building an Intl.DateTimeFormat is far slower than using one, and lists
// format a time per row, so each (time zone, shape) gets one formatter.
const DAY_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (shape: 'day' | 'time' | 'dateTime', timeZone: string) => {
  const key = `${shape}|${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const options = shape === 'day' ? DAY_OPTIONS : shape === 'time' ? TIME_OPTIONS : { ...DAY_OPTIONS, ...TIME_OPTIONS };
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, ...options });
    formatters.set(key, formatter);
  }
  return formatter;
};

const partsOf = (date: Date, shape: 'time' | 'dateTime', timeZone: string) =>
  Object.fromEntries(
    formatterFor(shape, timeZone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

// YYYY-MM-DD of `date` in the business time zone.
export const businessDay = (date: Date, timeZone = businessTimeZone()) => formatterFor('day', timeZone).format(date);

// HH:mm:ss of `date` in the business time zone.
export const businessClock = (date: Date, timeZone = businessTimeZone()) => {
  const parts = partsOf(date, 'time', timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
};

// YYYY-MM-DD HH:mm:ss of `date` in the business time zone.
export const businessDateTime = (date: Date, timeZone = businessTimeZone()) => {
  const parts = partsOf(date, 'dateTime', timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

// "10月1日": the month and day of `date` in the business time zone.
export const businessMonthDay = (date: Date, timeZone = businessTimeZone()) => {
  const day = businessDay(date, timeZone);
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
};

// The business day before `day` (YYYY-MM-DD); noon UTC avoids DST edges.
export const previousDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
