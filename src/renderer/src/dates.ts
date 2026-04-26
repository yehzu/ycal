export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const fmtDate = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const sameYMD = (a: Date, b: Date): boolean => fmtDate(a) === fmtDate(b);

export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const addMonths = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
};

export const startOfWeek = (d: Date, weekStart = 0): Date => {
  const x = new Date(d);
  const diff = (x.getDay() - weekStart + 7) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const startOfMonth = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), 1);

export const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
export const MONTH_SHORT = [
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
];
export const DOW_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const DOW_NARROW = ['S','M','T','W','T','F','S'];

export const formatTime = (date: Date): string => {
  const h = date.getHours();
  const m = date.getMinutes();
  const hr12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? 'a' : 'p';
  return m === 0 ? `${hr12}${ap}` : `${hr12}:${pad2(m)}${ap}`;
};

export const formatTimeFull = (date: Date): string => {
  const h = date.getHours();
  const m = date.getMinutes();
  const hr12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? 'AM' : 'PM';
  return `${hr12}:${pad2(m)} ${ap}`;
};

export const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const minutesOfDate = (d: Date): number => d.getHours() * 60 + d.getMinutes();
