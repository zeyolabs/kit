import { Format } from './strings/format';

/**
 * Transactional email layout, table-based with every style
 * inlined (the only markup that renders consistently across mail clients), a hidden preheader line,
 * an accent strip, a heading, label/value rows, one call-to-action button and a footer. The header
 * is a styled text wordmark, not an image or inline SVG, which Outlook, Gmail and Yahoo strip.
 *
 * Brand-agnostic: callers pass an `EmailBrand`. Colours are hex strings because mail clients have no
 * CSS variables. The same params also render a plain-text alternative, so the two never drift.
 */

export type EmailBrand = {
	/** Strip, badge and links. */
	accent: string;
	/** Text on a white card that must stay readable: wordmark, button fill. */
	accentDark: string;
	/** Badge background. */
	accentSoft: string;
	/** Printed in the footer, e.g. a postal address. */
	address?: string;
	name: string;
	supportEmail: string;
};

export type EmailRow = {
	label: string;
	strong?: boolean;
	/** Smaller line under the label, e.g. "2 × £18.00". */
	sub?: string;
	value: string;
};

export type EmailSection =
	{ lines: string[]; title: string } | { rows: EmailRow[]; title?: string };

export type EmailParams = {
	badge?: string;
	brand: EmailBrand;
	cta?: { href: string; label: string };
	eyebrow: string;
	footnote?: string;
	heading: string;
	/** Paragraphs under the heading. */
	intro: string[];
	/** Inbox-preview line. */
	preheader: string;
	sections: EmailSection[];
};

const FONT =
	"'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

const e = Format.escapeHtml;

function renderRows(rows: EmailRow[]): string {
	return rows
		.map(
			(row, i) => `
					${i > 0 ? `<tr><td colspan="2" style="border-top:1px solid ${RULE};height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>` : ''}
					<tr>
						<td style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK};padding:12px 12px 12px 0;font-weight:${row.strong ? 700 : 400};">
							${e(row.label)}${row.sub ? `<br /><span style="font-size:12.5px;color:${MUTED};font-weight:400;">${e(row.sub)}</span>` : ''}
						</td>
						<td align="right" valign="top" style="font-family:${FONT};font-size:14px;line-height:1.4;color:${INK};padding:12px 0;white-space:nowrap;font-weight:${row.strong ? 700 : 500};">${e(row.value)}</td>
					</tr>`
		)
		.join('');
}

function renderSection(section: EmailSection): string {
	const title = section.title
		? `<p style="font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:0 0 4px;">${e(section.title)}</p>`
		: '';
	const body =
		'rows' in section
			? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${renderRows(section.rows)}</table>`
			: `<p style="font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};margin:0;">${section.lines.map(e).join('<br />')}</p>`;
	return `
				<tr><td style="padding:0 36px 24px;">
					${title}
					${body}
				</td></tr>`;
}

export function renderEmail(params: EmailParams): string {
	const { brand } = params;
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<meta name="color-scheme" content="light" />
		<title>${e(params.heading)}</title>
	</head>
	<body style="background:#f4f5f0;margin:0;padding:0;">
		<div style="display:none;max-height:0;overflow:hidden;">${e(params.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
		<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f0;">
			<tr><td align="center" style="padding:40px 16px 48px;">
				<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

					<tr><td style="padding:0 4px 20px;">
						<span style="font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:-0.02em;color:${brand.accentDark};">${e(brand.name)}</span>
					</td></tr>

					<tr><td style="background:#ffffff;border:1px solid ${RULE};border-radius:12px;">
						<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
							<tr><td style="background:${brand.accent};height:4px;border-radius:12px 12px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>

							<tr><td style="padding:30px 36px 8px;">
								<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
									<tr>
										<td><span style="font-family:${FONT};font-size:11px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:0.08em;">${e(params.eyebrow)}</span></td>
										${params.badge ? `<td align="right"><span style="display:inline-block;background:${brand.accentSoft};color:${brand.accentDark};font-family:${FONT};font-size:11px;font-weight:600;padding:4px 10px;border-radius:99px;">${e(params.badge)}</span></td>` : ''}
									</tr>
								</table>
								<h1 style="font-family:${FONT};font-size:26px;font-weight:700;color:${INK};letter-spacing:-0.03em;line-height:1.25;margin:16px 0 12px;">${e(params.heading)}</h1>
								${params.intro.map((p) => `<p style="font-family:${FONT};font-size:14.5px;line-height:1.6;color:#4b5563;margin:0 0 12px;">${e(p)}</p>`).join('\n\t\t\t\t\t\t\t\t')}
							</td></tr>

							<tr><td style="padding:12px 36px 8px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:1px solid ${RULE};height:1px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
							${params.sections.map(renderSection).join('')}

							${
								params.cta
									? `<tr><td style="padding:0 36px 32px;">
								<table role="presentation" cellpadding="0" cellspacing="0" border="0">
									<tr><td style="background:${brand.accentDark};border-radius:8px;">
										<a href="${e(params.cta.href)}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;padding:12px 24px;">${e(params.cta.label)}</a>
									</td></tr>
								</table>
							</td></tr>`
									: ''
							}
						</table>
					</td></tr>

					<tr><td align="center" style="padding-top:28px;">
						<p style="font-family:${FONT};font-size:12.5px;color:${MUTED};line-height:1.7;margin:0;text-align:center;">
							${params.footnote ? `${e(params.footnote)}<br />` : ''}
							Questions? Reply to this email or write to <a href="mailto:${e(brand.supportEmail)}" style="color:${MUTED};text-decoration:underline;">${e(brand.supportEmail)}</a>.${brand.address ? `<br />${e(brand.name)}, ${e(brand.address)}` : ''}
						</p>
					</td></tr>

				</table>
			</td></tr>
		</table>
	</body>
</html>`;
}

/** The same content as plain text, for clients that don't show HTML and as the multipart fallback. */
export function renderEmailText(params: EmailParams): string {
	const out: string[] = [params.heading, '', ...params.intro.flatMap((p) => [p, ''])];
	for (const section of params.sections) {
		if (section.title) out.push(section.title.toUpperCase());
		if ('rows' in section) {
			for (const row of section.rows) {
				out.push(`${row.label}${row.sub ? ` (${row.sub})` : ''}: ${row.value}`);
			}
		} else {
			out.push(...section.lines);
		}
		out.push('');
	}
	if (params.cta) out.push(`${params.cta.label}: ${params.cta.href}`, '');
	if (params.footnote) out.push(params.footnote, '');
	out.push(`Questions? Reply to this email or write to ${params.brand.supportEmail}.`);
	return out.join('\n') + '\n';
}
