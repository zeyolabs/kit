/**
 * Format an amount held in minor units (pence, cents, ...) for display. Store money as integer
 * minor units and only format at the edge. The divisor follows the currency's own fraction digits,
 * so zero-decimal currencies (JPY) and three-decimal ones (KWD) come out right.
 */
export function formatMinorUnits(amount: number, currency: string, locale: string): string {
	const formatter = new Intl.NumberFormat(locale, { currency, style: 'currency' });
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(amount / 10 ** digits);
}
