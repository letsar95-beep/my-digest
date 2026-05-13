const MONTHS_RU = [
  'января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря',
];

/** "2026-05-11" or "2026-05-11T..." → "11 мая" */
export function formatDate(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
}

/** "2026-05-12T10:00:00" → "10:00" */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Returns "через N дней/дня/день" or "сегодня" */
export function nextIssueLabel(nextIsoDatetime: string): string {
  const diffMs = new Date(nextIsoDatetime).getTime() - Date.now();
  const days = Math.ceil(diffMs / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'через 1 день';
  if (days <= 4) return `через ${days} дня`;
  return `через ${days} дней`;
}
