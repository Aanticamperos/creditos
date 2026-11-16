import { addDaysISO } from './dates';

export interface HolidayItem {
  holiday_date: string;
  description: string;
  source: string;
}

/** Anonymous Gregorian Easter Sunday calculator (Meeus/Jones/Butcher). */
function easterSundayISO(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Shifts a holiday date to the following Monday if not already Monday (Ley 51 de 1983 / Ley Emiliani). */
function emilianiMonday(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  if (dow === 1) return isoDate;
  const shift = dow === 0 ? 1 : 8 - dow;
  return addDaysISO(isoDate, shift);
}

/** Generates all 18 official national holidays in Colombia for a given calendar year. */
export function getColombianHolidays(year: number): HolidayItem[] {
  const easter = easterSundayISO(year);
  const y = String(year);
  const fixed = [
    [`${y}-01-01`, 'Año Nuevo'],
    [`${y}-05-01`, 'Día del Trabajo'],
    [`${y}-07-20`, 'Día de la Independencia'],
    [`${y}-08-07`, 'Batalla de Boyacá'],
    [`${y}-12-08`, 'Inmaculada Concepción'],
    [`${y}-12-25`, 'Navidad'],
  ] as const;

  const emiliani = [
    [`${y}-01-06`, 'Día de los Reyes Magos'],
    [`${y}-03-19`, 'Día de San José'],
    [`${y}-06-29`, 'San Pedro y San Pablo'],
    [`${y}-08-15`, 'La Asunción de la Virgen'],
    [`${y}-10-12`, 'Día de la Raza'],
    [`${y}-11-01`, 'Todos los Santos'],
    [`${y}-11-11`, 'Independencia de Cartagena'],
  ] as const;

  const easterRelated = [
    [addDaysISO(easter, -3), 'Jueves Santo'],
    [addDaysISO(easter, -2), 'Viernes Santo'],
    [emilianiMonday(addDaysISO(easter, 39)), 'Ascensión del Señor'],
    [emilianiMonday(addDaysISO(easter, 60)), 'Corpus Christi'],
    [emilianiMonday(addDaysISO(easter, 68)), 'Sagrado Corazón de Jesús'],
  ] as const;

  const all: HolidayItem[] = [
    ...fixed.map(([holiday_date, description]) => ({
      holiday_date,
      description,
      source: 'colombia_ley_51',
    })),
    ...emiliani.map(([raw, description]) => ({
      holiday_date: emilianiMonday(raw),
      description,
      source: 'colombia_ley_51',
    })),
    ...easterRelated.map(([holiday_date, description]) => ({
      holiday_date,
      description,
      source: 'colombia_ley_51',
    })),
  ];

  const uniqueMap = new Map<string, HolidayItem>();
  for (const item of all) {
    uniqueMap.set(item.holiday_date, item);
  }
  return Array.from(uniqueMap.values()).sort((a, b) =>
    a.holiday_date.localeCompare(b.holiday_date),
  );
}
