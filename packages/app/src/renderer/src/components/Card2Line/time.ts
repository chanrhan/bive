// 카드 2줄째 시각 표기: 로컬 시각 `YYYY-MM-DD HH:mm` (ADR-048). 해석할 수 없으면 null(미표시, NFR-03).

const pad = (n: number): string => String(n).padStart(2, '0');

export const formatCardTime = (iso: string): string | null => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
