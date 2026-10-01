import { createHash, timingSafeEqual } from 'node:crypto';

/** Administrator route: `GET` lists users; `PUT`/`DELETE /admin/users/<id>` manage one user. */
export const usersPath = '/admin/users';

export function adminDigest(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function matchesToken(token: string | null, digest: string): boolean {
	if (!token || !/^[a-f0-9]{64}$/.test(digest)) return false;
	const supplied = adminDigest(token);

	return timingSafeEqual(new TextEncoder().encode(supplied), new TextEncoder().encode(digest));
}

export function isAdministrator(request: Request, digest: string): boolean {
	const authorization = request.headers.get('authorization');

	return matchesToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : null, digest);
}

export function adminOrigin(input: string): string {
	const url = new URL(input);
	const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';

	if (
		(url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('Use an HTTPS origin, or loopback HTTP for local development.');

	return url.origin;
}
