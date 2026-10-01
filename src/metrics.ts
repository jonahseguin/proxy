import { Option, Schema } from 'effect';

import { credentialKey, type AccountInfo, type Provider, type UsageWindow } from './account.ts';

const OptionalNumber = Schema.optionalKey(Schema.Number);
const Snapshot = Schema.Struct({
	observed_at: Schema.optionalKey(Schema.String),
	signals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const AuthFiles = Schema.Struct({
	files: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			auth_index: Schema.optionalKey(Schema.String),
			provider: Schema.optionalKey(Schema.String),
			type: Schema.optionalKey(Schema.String),
			status: Schema.optionalKey(Schema.String),
			disabled: Schema.optionalKey(Schema.Boolean),
			unavailable: Schema.optionalKey(Schema.Boolean),
			success: OptionalNumber,
			failed: OptionalNumber,
			next_retry_after: Schema.optionalKey(Schema.String),
			quota: Schema.optionalKey(Snapshot),
		}),
	),
});
const safeSignals = (signals: Readonly<Record<string, string>>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(signals).filter(
			([name, value]) =>
				/^(?:retry-after|x-codex-[a-z0-9-]+(?:used-percent|window-minutes|reset-after-seconds|reset-at|allowed|limit-reached)|anthropic-ratelimit-unified-[a-z0-9-]+)$/i.test(
					name,
				) && /^(?:[0-9.:%TZ+ -]+|true|false|allowed|not_allowed)$/.test(value),
		),
	);
export const accountMetrics = (
	user: string,
	account: AccountInfo,
	value: unknown,
	countsSince?: string,
): { account: AccountInfo; authIndex?: string } => {
	const parsed = Schema.decodeUnknownOption(AuthFiles)(value);
	if (Option.isNone(parsed)) return { account };
	const name = credentialKey(user, account.provider, account.id).slice('auths/'.length);
	const file = parsed.value.files.find(
		(candidate) =>
			candidate.name === name && (candidate.provider ?? candidate.type) === account.provider,
	);
	if (file === undefined) return { account };
	const retryAt =
		file.next_retry_after !== undefined && Number.isFinite(Date.parse(file.next_retry_after))
			? new Date(file.next_retry_after).toISOString()
			: undefined;
	const success =
		file.success !== undefined && Number.isSafeInteger(file.success) && file.success >= 0
			? file.success
			: undefined;
	const failed =
		file.failed !== undefined && Number.isSafeInteger(file.failed) && file.failed >= 0
			? file.failed
			: undefined;
	const observedAt =
		file.quota?.observed_at !== undefined && Number.isFinite(Date.parse(file.quota.observed_at))
			? file.quota.observed_at
			: undefined;
	const signals = file.quota?.signals === undefined ? {} : safeSignals(file.quota.signals);
	return {
		...(file.auth_index === undefined ? {} : { authIndex: file.auth_index }),
		account: {
			...account,
			health: {
				state:
					file.disabled === true
						? 'disabled'
						: file.unavailable === true
							? 'unavailable'
							: file.status === 'active'
								? 'ready'
								: file.status === 'disabled'
									? 'disabled'
									: file.status === 'error'
										? 'unavailable'
										: 'unknown',
				...(retryAt === undefined ? {} : { retryAt }),
			},
			usage: {
				state: success !== undefined || failed !== undefined ? 'observed' : 'unavailable',
				quotaState: 'unavailable',
				...(success === undefined ? {} : { success }),
				...(failed === undefined ? {} : { failed }),
				...(countsSince === undefined ? {} : { countsSince }),
				...(observedAt === undefined || Object.keys(signals).length === 0
					? {}
					: { quota: { observedAt, signals } }),
			},
		},
	};
};
export function quotaRequest(
	account: AccountInfo,
	authIndex: string,
): { auth_index: string; method: string; url: string; header: Record<string, string> } {
	return account.provider === 'claude'
		? {
				auth_index: authIndex,
				method: 'GET',
				url: 'https://api.anthropic.com/api/oauth/usage',
				header: {
					Authorization: 'Bearer $TOKEN$',
					'Content-Type': 'application/json',
					'anthropic-beta': 'oauth-2025-04-20',
					'User-Agent': 'claude-cli/2.1.280 (external, cli)',
				},
			}
		: {
				auth_index: authIndex,
				method: 'GET',
				url: 'https://chatgpt.com/backend-api/wham/usage',
				header: {
					Authorization: 'Bearer $TOKEN$',
					'Content-Type': 'application/json',
					'Chatgpt-Account-Id': account.accountId ?? '',
					'User-Agent':
						'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
				},
			};
}
const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const numeric = Schema.decodeUnknownOption(Schema.Union([Schema.Number, Schema.String]));
const finite = (value: unknown): number | undefined => {
	const decoded = numeric(value);
	if (Option.isNone(decoded) || decoded.value === '') return undefined;
	const result = Number(decoded.value);
	return Number.isFinite(result) ? result : undefined;
};
const window = (
	name: string,
	value: unknown,
	provider: Provider,
	observedAt: string,
): typeof UsageWindow.Type | undefined => {
	const parsed = record(value);
	if (Option.isNone(parsed)) return undefined;
	const usedPercent = finite(parsed.value[provider === 'claude' ? 'utilization' : 'used_percent']);
	if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined;
	let resetAt: string | undefined;
	if (provider === 'claude') {
		const date = Schema.decodeUnknownOption(Schema.String)(parsed.value['resets_at']);
		if (Option.isSome(date) && Number.isFinite(Date.parse(date.value)))
			resetAt = new Date(date.value).toISOString();
	} else {
		const timestamp = finite(parsed.value['reset_at']);
		const seconds = finite(parsed.value['reset_after_seconds']);
		const milliseconds =
			timestamp !== undefined
				? timestamp * 1000
				: seconds !== undefined
					? Date.parse(observedAt) + seconds * 1000
					: undefined;
		if (milliseconds !== undefined && milliseconds >= 0 && milliseconds <= 8.64e15)
			resetAt = new Date(milliseconds).toISOString();
	}
	return { name, usedPercent, ...(resetAt === undefined ? {} : { resetAt }) };
};
export function quotaWindows(
	provider: Provider,
	value: unknown,
	observedAt: string,
): readonly (typeof UsageWindow.Type)[] {
	const parsed = record(value);
	if (Option.isNone(parsed)) return [];
	const windows: (typeof UsageWindow.Type)[] = [];
	if (provider === 'claude') {
		for (const name of [
			'five_hour',
			'seven_day',
			'seven_day_opus',
			'seven_day_sonnet',
			'seven_day_oauth_apps',
			'seven_day_cowork',
		]) {
			const result = window(name, parsed.value[name], provider, observedAt);
			if (result !== undefined) windows.push(result);
		}
	} else {
		for (const [field, prefix] of [
			['rate_limit', ''],
			['code_review_rate_limit', 'review_'],
		] as const) {
			const limits = record(parsed.value[field]);
			if (Option.isNone(limits)) continue;
			for (const name of ['primary', 'secondary']) {
				const result = window(
					`${prefix}${name}`,
					limits.value[`${name}_window`],
					provider,
					observedAt,
				);
				if (result !== undefined) windows.push(result);
			}
		}
	}
	return windows;
}
