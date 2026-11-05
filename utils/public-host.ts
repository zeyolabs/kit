export function parseIPv4(ip: string): null | number[] {
	const parts = ip.split('.').map(Number);
	return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
		? parts
		: null;
}

function parseIPv6(ip: string): null | number[] {
	let text = ip;
	const lastColon = text.lastIndexOf(':');
	if (text.includes('.')) {
		const v4 = parseIPv4(text.slice(lastColon + 1));
		if (!v4) return null;
		text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves[1] ? halves[1].split(':') : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
	const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) =>
		/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN
	);
	return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

// Not publicly routable: this-network, RFC1918, CGNAT (covers Alibaba metadata 100.100.100.200),
// loopback, link-local (covers AWS/GCP/Azure metadata 169.254.169.254), IETF/benchmark, multicast+reserved.
function isPrivateIPv4([a, b, c]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

// Unparseable input counts as private: fail closed.
export function isPrivateAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) return isPrivateIPv4(v4);
	const g = parseIPv6(address);
	if (!g) return true;
	// ::/96 (incl. :: and ::1) and ::ffff:0:0/96 embed an IPv4 address in the last 32 bits.
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
		return isPrivateIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
	}
	// fc00::/7 unique-local (covers AWS fd00:ec2::254), fe80::/10 link-local, ff00::/8 multicast.
	return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

/** Whether a URL hostname could be a public destination, judged without DNS: an IP literal must
 *  be publicly routable and `localhost` is out. A name that resolves to a private address is
 *  caught at delivery time instead. */
export function isPublicHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) return false;
	return parseIPv4(host) || host.includes(':') ? !isPrivateAddress(host) : true;
}
