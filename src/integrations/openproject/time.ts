export function formatSlashDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${day}/${month}/${year}`;
}

export function formatYYYYMMDD(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${year}-${month}-${day}`;
}

export function parseDateNoon(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function getPreviousWorkingDay(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  const dayOfWeek = result.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  if (dayOfWeek === 1) {
    result.setDate(result.getDate() - 3); // Monday -> Friday
  } else if (dayOfWeek === 0) {
    result.setDate(result.getDate() - 2); // Sunday -> Friday
  } else if (dayOfWeek === 6) {
    result.setDate(result.getDate() - 1); // Saturday -> Friday
  } else {
    result.setDate(result.getDate() - 1); // Tue-Fri -> prev day
  }
  return result;
}
