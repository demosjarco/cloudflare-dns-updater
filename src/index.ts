import Cloudflare from 'cloudflare';
import type { AppListResponse } from 'cloudflare/resources/spectrum.mjs';
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext/browser';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types.mjs';

const uuidv4Hex = /^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[0-9a-f]{4}[0-9a-f]{12}$/i;
const baseConfig = zm.object({
	tunnel_id: zm.uuidv4(),
	failure_email: zm.optional(zm.email({ pattern: zm.regexes.html5Email })),
});
const ztLocationsConfig = zm
	.array(
		zm.union([
			// It's technically a uuid, just without hyphens
			zm.string().check(zm.trim(), zm.minLength(1), zm.regex(uuidv4Hex)),
			zm.pipe(
				zm.uuidv4(),
				zm.transform((uuidWithHyphens) => uuidWithHyphens.replaceAll('-', '')),
			),
		]),
	)
	.check(zm.minLength(1));
const dnsRecordConfigBase = zm.object({
	zone_id: zm.string().check(zm.trim(), zm.minLength(1), zm.maxLength(32)),
});
const recordName = zm.string().check(zm.trim(), zm.regex(zm.regexes.domain));
const dnsRecordConfig = zm
	.array(
		zm.union([
			zm.extend(dnsRecordConfigBase, {
				record_name: zm.array(recordName).check(zm.minLength(1)),
			}),
			zm.extend(dnsRecordConfigBase, {
				spectrum_record_name: zm.array(recordName).check(zm.minLength(1)),
			}),
			zm.extend(dnsRecordConfigBase, {
				record_name: zm.array(recordName).check(zm.minLength(1)),
				spectrum_record_name: zm.array(recordName).check(zm.minLength(1)),
			}),
		]),
	)
	.check(zm.minLength(1));
const schema = await zm
	.array(
		zm.union([
			zm.extend(baseConfig, {
				zt_locations: ztLocationsConfig,
			}),
			zm.extend(baseConfig, {
				dns_records: dnsRecordConfig,
			}),
			zm.extend(baseConfig, {
				zt_locations: ztLocationsConfig,
				dns_records: dnsRecordConfig,
			}),
		]),
	)
	.check(zm.minLength(1));

export default <ExportedHandler<EnvVars>>{
	async scheduled(event, env, ctx) {
		const { success, data: config, error } = await schema.safeParseAsync(typeof env.CONFIG === 'string' ? JSON.parse(env.CONFIG) : env.CONFIG);
		if (success) {
			const cf = new Cloudflare({ apiToken: env.CF_API_TOKEN, fetch: globalThis.fetch });

			await Promise.allSettled(
				config.map(async (tunnelConfig) => {
					const connIps =
						// Deduplicate the connection IPs
						Array.from(
							new Set(
								// Get the list of connections for the tunnel
								(await Array.fromAsync(cf.zeroTrust.tunnels.cloudflared.connections.get(tunnelConfig.tunnel_id, { account_id: env.CF_ACCOUNT_ID })))
									// Extract the connections object
									.flatMap(({ conns }) => conns)
									// Extract the origin ips and parse ipv4 only
									.map((conn) => zm.ipv4().safeParse(conn?.origin_ip).data)
									// Trim out anything else (undefineds, etc)
									.filter((origin_ip) => typeof origin_ip === 'string'),
							),
						);

					if (connIps.length > 0) {
						const dedupedConnIps = Array.from(new Set(connIps));

						const spectrumAppsByZone: Record<string, AppListResponse> =
							'dns_records' in tunnelConfig
								? await Object.entries(
										tunnelConfig.dns_records
											.filter((dnsRecordConfig) => 'spectrum_record_name' in dnsRecordConfig)
											.reduce(
												(acc, dnsRecordConfig) => {
													const zoneSet = acc[dnsRecordConfig.zone_id] ?? new Set<string>();
													dnsRecordConfig.spectrum_record_name.forEach((recordName) => zoneSet.add(recordName));
													acc[dnsRecordConfig.zone_id] = zoneSet;
													return acc;
												},
												{} as Record<string, Set<string>>,
											),
									).reduce(
										async (recordPromise, [zone_id, recordNames]) => {
											const record = await recordPromise;
											record[zone_id] = (
												await Array.fromAsync(
													cf.spectrum.apps.list({
														zone_id,
														/**
														 * @link https://developers.cloudflare.com/api/resources/spectrum/subresources/apps/methods/list/
														 */
														per_page: 100,
													}),
												)
											)
												.flat()
												.filter((spectrum_app) => typeof spectrum_app.dns.name === 'string')
												.filter((spectrum_app) => recordNames.has(spectrum_app.dns.name!));
											return record;
										},
										Promise.resolve({} as Record<string, AppListResponse>),
									)
								: {};

						await Promise.allSettled([
							...('zt_locations' in tunnelConfig
								? tunnelConfig.zt_locations.map((zt_location_id) =>
										cf.zeroTrust.gateway.locations
											.get(zt_location_id, {
												account_id: env.CF_ACCOUNT_ID,
											})
											.then((zt_location) => {
												if (zt_location) {
													return cf.zeroTrust.gateway.locations.update(zt_location_id, {
														account_id: env.CF_ACCOUNT_ID,
														name: zt_location.name!,
														...('client_default' in zt_location ? { client_default: zt_location.client_default } : {}),
														...('dns_destination_ips_id' in zt_location ? { dns_destination_ips_id: zt_location.dns_destination_ips_id } : {}),
														...('ecs_support' in zt_location ? { ecs_support: zt_location.ecs_support } : {}),
														...('endpoints' in zt_location ? { endpoints: zt_location.endpoints } : {}),
														networks: dedupedConnIps.map((ip) => ({ network: `${ip}/32` })),
													});
												} else {
													throw new Error(`ZT Location with ID ${zt_location_id} not found.`);
												}
											}),
									)
								: []),
							...('dns_records' in tunnelConfig
								? tunnelConfig.dns_records
										.map((dnsRecordConfig) => [
											...('record_name' in dnsRecordConfig
												? dnsRecordConfig.record_name.map((record_name) =>
														Array.fromAsync(
															cf.dns.records.list({
																zone_id: dnsRecordConfig.zone_id,
																/**
																 * @link https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
																 */
																per_page: 5000000,
																type: 'A',
																name: { exact: record_name },
															}),
														).then((dnsRecords) =>
															cf.dns.records.batch({
																zone_id: dnsRecordConfig.zone_id,
																...(dnsRecords.length > 0 && { deletes: dnsRecords.map(({ id }) => ({ id })) }),
																posts: dedupedConnIps.map((ip) => ({
																	name: record_name,
																	// Setting to 1 means 'automatic'
																	ttl: dnsRecords[0]?.ttl ?? 1,
																	type: 'A',
																	...(dnsRecords[0]?.comment && { comment: dnsRecords[0]?.comment }),
																	content: ip,
																	...(dnsRecords[0]?.proxied && { proxied: dnsRecords[0]?.proxied }),
																	...(dnsRecords[0]?.settings && { settings: dnsRecords[0]?.settings }),
																	...(dnsRecords[0]?.tags && { tags: dnsRecords[0]?.tags }),
																})),
															}),
														),
													)
												: []),
											...('spectrum_record_name' in dnsRecordConfig
												? spectrumAppsByZone[dnsRecordConfig.zone_id]!.filter((spectrum_app) => spectrum_app.dns.name && dnsRecordConfig.spectrum_record_name.includes(spectrum_app.dns.name)).map((spectrum_app) =>
														cf.spectrum.apps.update(spectrum_app.id, {
															zone_id: dnsRecordConfig.zone_id,
															dns: spectrum_app.dns,
															protocol: spectrum_app.protocol,
															...('traffic_type' in spectrum_app && { traffic_type: spectrum_app.traffic_type }),
															...('argo_smart_routing' in spectrum_app && { argo_smart_routing: spectrum_app.argo_smart_routing }),
															...('edge_ips' in spectrum_app && { edge_ips: spectrum_app.edge_ips }),
															...('ip_firewall' in spectrum_app && { ip_firewall: spectrum_app.ip_firewall }),
															...('origin_direct' in spectrum_app && {
																origin_direct: dedupedConnIps.map((ip) => {
																	const originalUrl = new URL(spectrum_app.origin_direct![0]!);
																	originalUrl.hostname = ip;
																	return originalUrl.href;
																}),
															}),
															...('origin_dns' in spectrum_app && { origin_dns: spectrum_app.origin_dns }),
															...('origin_port' in spectrum_app && { origin_port: spectrum_app.origin_port }),
															...('proxy_protocol' in spectrum_app && { proxy_protocol: spectrum_app.proxy_protocol }),
															...('tls' in spectrum_app && { tls: spectrum_app.tls }),
														}),
													)
												: []),
										])
										.flat()
								: []),
						]).then((results) => {
							const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
							if (errors.length > 0) {
								throw errors;
							}
						});
					} else {
						const errorMessage = `The Cloudflared tunnel with ID ${tunnelConfig.tunnel_id} is currently down. ${Object.keys(tunnelConfig)
							.filter((keys) => (['tunnel_id', 'failure_email'] satisfies (keyof typeof tunnelConfig)[]).includes(keys as keyof typeof tunnelConfig))
							.join(',')} are not being updated.` as const;

						if (tunnelConfig.failure_email) {
							const msg = createMimeMessage();

							msg.setSender({ name: 'DNS Updater', addr: tunnelConfig.failure_email });
							msg.setRecipient(tunnelConfig.failure_email);
							msg.setSubject('Cloudflared Tunnel Down Alert');
							msg.addMessage({ contentType: 'text/plain', data: errorMessage });

							ctx.waitUntil(env.EMAIL.send(new EmailMessage(tunnelConfig.failure_email, tunnelConfig.failure_email, msg.asRaw())));
						}

						throw new Error(errorMessage);
					}
				}),
			).then((results) => {
				const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
				if (errors.length > 0) {
					throw errors;
				}
			});
		} else {
			console.error(zm.prettifyError(error));
			throw error;
		}
	},
};
