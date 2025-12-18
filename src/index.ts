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
				dns_records: dnsRecordConfig,
			}),
			zm.extend(baseConfig, {
				zt_locations: ztLocationsConfig,
			}),
			zm.extend(baseConfig, {
				dns_records: dnsRecordConfig,
			}),
		]),
	)
	.check(zm.minLength(1));

export default <ExportedHandler<EnvVars>>{
	async scheduled(event, env, ctx) {
		const { success, data: config, error } = await schema.safeParseAsync(typeof env.CONFIG === 'string' ? JSON.parse(env.CONFIG) : env.CONFIG);
		if (success) {
			console.debug('Parsed configuration', config);

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
					console.debug(`For tunnel ${tunnelConfig.tunnel_id} got connection IPs`, connIps);

					if (connIps.length > 0) {
						const dedupedConnIps = Array.from(new Set(connIps));
						console.debug(`Deduped connection IPs for tunnel ${tunnelConfig.tunnel_id}`, dedupedConnIps);

						let spectrumAppsByZone: Record<string, AppListResponse> = {};
						if ('dns_records' in tunnelConfig) {
							const temp = Object.entries(
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
							);
							console.debug('temp', temp);

							spectrumAppsByZone = Object.fromEntries(
								await Promise.all(
									temp.map(async ([zone_id, recordNames]) => {
										console.debug({ zone_id, recordNames: Array.from(recordNames) });

										const appsForZone = (
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

										return [zone_id, appsForZone] as const;
									}),
								),
							);
						}

						console.debug(`Fetched Spectrum apps for tunnel ${tunnelConfig.tunnel_id}`, spectrumAppsByZone);

						await Promise.allSettled([
							...('zt_locations' in tunnelConfig
								? tunnelConfig.zt_locations.map((zt_location_id) =>
										cf.zeroTrust.gateway.locations
											.get(zt_location_id, {
												account_id: env.CF_ACCOUNT_ID,
											})
											.then((zt_location) => {
												if (zt_location) {
													console.debug(`Fetched ZT Location for tunnel ${tunnelConfig.tunnel_id}`, zt_location);

													return cf.zeroTrust.gateway.locations
														.update(zt_location_id, {
															account_id: env.CF_ACCOUNT_ID,
															name: zt_location.name!,
															...('client_default' in zt_location ? { client_default: zt_location.client_default } : {}),
															...('dns_destination_ips_id' in zt_location ? { dns_destination_ips_id: zt_location.dns_destination_ips_id } : {}),
															...('ecs_support' in zt_location ? { ecs_support: zt_location.ecs_support } : {}),
															...('endpoints' in zt_location ? { endpoints: zt_location.endpoints } : {}),
															networks: dedupedConnIps.map((ip) => ({ network: `${ip}/32` })),
														})
														.then((updatedLocation) => console.debug(`Updated ZT Location for tunnel ${tunnelConfig.tunnel_id}`, updatedLocation));
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
														).then((dnsRecords) => {
															console.debug(`Fetched DNS records for tunnel ${tunnelConfig.tunnel_id}, zone ${dnsRecordConfig.zone_id}, record name ${record_name}`, dnsRecords);

															return cf.dns.records
																.batch({
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
																})
																.then((updatedRecord) => console.debug(`Updated DNS records for tunnel ${tunnelConfig.tunnel_id}, zone ${dnsRecordConfig.zone_id}, record name ${record_name}`, updatedRecord));
														}),
													)
												: []),
											...('spectrum_record_name' in dnsRecordConfig
												? spectrumAppsByZone[dnsRecordConfig.zone_id]!.filter((spectrum_app) => spectrum_app.dns.name && dnsRecordConfig.spectrum_record_name.includes(spectrum_app.dns.name)).map((spectrum_app) => {
														console.debug(`Fetched Spectrum app for tunnel ${tunnelConfig.tunnel_id}, zone ${dnsRecordConfig.zone_id}, app ID ${spectrum_app.id}`, spectrum_app);

														return cf.spectrum.apps
															.update(spectrum_app.id, {
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
																		console.log('originalUrl', originalUrl);
																		originalUrl.hostname = ip;
																		console.log('changedUrl', originalUrl);
																		return originalUrl.href;
																	}),
																}),
																...('origin_dns' in spectrum_app && { origin_dns: spectrum_app.origin_dns }),
																...('origin_port' in spectrum_app && { origin_port: spectrum_app.origin_port }),
																...('proxy_protocol' in spectrum_app && { proxy_protocol: spectrum_app.proxy_protocol }),
																...('tls' in spectrum_app && { tls: spectrum_app.tls }),
															})
															.then((updatedApp) => console.debug(`Updated Spectrum app for tunnel ${tunnelConfig.tunnel_id}, zone ${dnsRecordConfig.zone_id}, app ID ${spectrum_app.id}`, updatedApp));
													})
												: []),
										])
										.flat()
								: []),
						]).then((results) => {
							const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
							if (errors.length > 0) {
								if (errors.every((e) => e instanceof Error)) {
									throw new Error(JSON.stringify(errors.map((e) => e.message)), { ...(errors.some((e) => e.cause) && { cause: JSON.stringify(errors.map((e) => e.cause)) }) });
								} else {
									throw errors.map((e) => {
										if (e instanceof Error) {
											return {
												name: e.name,
												message: e.message,
												cause: e.cause,
												stack: e.stack,
											};
										} else {
											return e;
										}
									});
								}
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
					if (errors.every((e) => e instanceof Error)) {
						throw new Error(JSON.stringify(errors.map((e) => e.message)), { ...(errors.some((e) => e.cause) && { cause: JSON.stringify(errors.map((e) => e.cause)) }) });
					} else {
						throw errors.map((e) => {
							if (e instanceof Error) {
								return {
									name: e.name,
									message: e.message,
									cause: e.cause,
									stack: e.stack,
								};
							} else {
								return e;
							}
						});
					}
				}
			});
		} else {
			console.error(zm.prettifyError(error));
			throw error;
		}
	},
};
