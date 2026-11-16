const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const compactCopFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCOP(value: number | string | null | undefined): string {
  const num = Number(value ?? 0);
  return copFormatter.format(Number.isFinite(num) ? Math.round(num) : 0);
}

export function formatCompactCOP(value: number | string | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return formatCOP(0);
  if (Math.abs(num) < 1_000_000) return formatCOP(num);
  return compactCopFormatter.format(num);
}

export function parsePositiveInt(value: unknown): number {
  const num = typeof value === 'string' ? Number(value.replace(/[^\d.-]/g, '')) : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}
