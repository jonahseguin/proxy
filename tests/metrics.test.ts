import { expect, it } from '@effect/vitest';

import { accountId, type AccountInfo, type ClaudeCredential } from '../src/account.ts';
import { accountMetrics, quotaRequest, quotaWindows } from '../src/metrics.ts';

const credential: ClaudeCredential = {
	type: 'claude',
	email: 'account@example.test',
	organization_uuid: 'org-personal',
	account_uuid: 'account-1',
	access_token: 'synthetic-access',
	refresh_token: 'synthetic-refresh',
	expired: '2099-01-01T00:00:00Z',
};
const identity: AccountInfo = {
	id: accountId(credential),
	provider: 'claude',
	email: credential.email,
	organizationId: 'org-personal',
	accessTokenExpiresAt: credential.expired,
	health: { state: 'unknown' },
	usage: { state: 'unavailable', quotaState: 'unavailable' },
};

it('joins private CPA metrics only to the owned credential filename and removes private fields', () => {
	const value = {
		files: [
			{
				name: `alice__claude__${identity.id}.json`,
				auth_index: 'owned-index',
				provider: 'claude',
				status: 'active',
				success: 7,
				failed: 2,
				access_token: 'private-token',
				path: '/private/secret',
				id_token: { claims: 'private' },
				recent_requests: [{ body: 'private body' }],
				quota: {
					observed_at: '2026-10-01T20:00:00Z',
					signals: {
						'X-Codex-Primary-Used-Percent': '58',
						Authorization: 'private-token',
						'Retry-After': '120',
					},
				},
			},
			{
				name: 'bob__claude__other.json',
				auth_index: 'foreign-index',
				provider: 'claude',
				status: 'active',
				success: 999,
				failed: 999,
			},
		],
	};
	const result = accountMetrics('alice', identity, value, '2026-10-01T19:00:00Z');
	expect(result.authIndex).toBe('owned-index');
	expect(result.account.usage.success).toBe(7);
	expect(result.account.health.state).toBe('ready');
	expect(result.account.usage.quota?.signals).toEqual({
		'X-Codex-Primary-Used-Percent': '58',
		'Retry-After': '120',
	});
	expect(JSON.stringify(result.account)).not.toMatch(/private|999|owned-index/);
	expect(accountMetrics('bob', identity, value, '2026-10-01T19:00:00Z').authIndex).toBeUndefined();
});

it('generates only fixed private quota calls with token substitution and the correct account', () => {
	const claude = quotaRequest(identity, 'owned-index');
	expect(claude.url).toBe('https://api.anthropic.com/api/oauth/usage');
	expect(claude.header.Authorization).toBe('Bearer $TOKEN$');
	const codex = quotaRequest(
		{ ...identity, provider: 'codex', accountId: 'chatgpt-own-account' },
		'codex-index',
	);
	expect(codex.url).toBe('https://chatgpt.com/backend-api/wham/usage');
	expect(codex.header['Chatgpt-Account-Id']).toBe('chatgpt-own-account');
});

it('reads zero usage correctly and converts provider reset times without exposing provider responses', () => {
	const claude = quotaWindows(
		'claude',
		{
			five_hour: { utilization: 0, resets_at: '2026-10-01T23:00:00Z' },
			seven_day: { utilization: 58, resets_at: null },
		},
		'2026-10-01T20:00:00Z',
	);
	expect(claude).toEqual([
		{ name: 'five_hour', usedPercent: 0, resetAt: '2026-10-01T23:00:00.000Z' },
		{ name: 'seven_day', usedPercent: 58 },
	]);
	const codex = quotaWindows(
		'codex',
		{
			rate_limit: {
				primary_window: { used_percent: '42', reset_after_seconds: '120' },
				secondary_window: { used_percent: 7, reset_at: 1790884800 },
			},
		},
		'2026-10-01T20:00:00Z',
	);
	expect(codex[0]).toEqual({
		name: 'primary',
		usedPercent: 42,
		resetAt: '2026-10-01T20:02:00.000Z',
	});
	expect(
		quotaWindows(
			'claude',
			{ five_hour: { utilization: 'invalid' }, private_token: 'secret' },
			'2026-10-01T20:00:00Z',
		),
	).toEqual([]);
	expect(
		quotaWindows(
			'codex',
			{ rate_limit: { primary_window: { used_percent: -1 } } },
			'2026-10-01T20:00:00Z',
		),
	).toEqual([]);
});
