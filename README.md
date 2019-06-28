# Cloudflare DNS Updater Worker

Scheduled Cloudflare Worker that keeps DNS A records, Spectrum app origins, and Zero Trust Gateway location networks in sync with the current connection IPs of one or more Cloudflared tunnels. Runs every 5 minutes; optionally sends an alert email when a tunnel is down.

## How it works

- On each cron run (_/5 _ \* \* \*), the worker fetches the active connection IPs for each configured Cloudflared tunnel.
- Updates Zero Trust Gateway location `networks` to those IPs (/32).
- Recreates A records for configured hostnames so they point to the current connector IPs (preserves TTL, proxied, comment, settings, tags when present).
- Updates Spectrum apps so their `origin_direct` hostnames use the current connector IPs.
- If a tunnel has no active connectors, the run fails and, if `failure_email` is set for that tunnel, an email is sent to that address.

## Prerequisites

- Cloudflare account and Cloudflared tunnels already created.
- Node.js 20+ and npm.
- Wrangler 4+ installed (`npm i -g wrangler`), or use `npx wrangler`.
- Email Routing: verify the sender/recipient you will use for `failure_email` under Email Routing so messages can be delivered.

## API token permissions

[Create a token](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22teams%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22teams_connector_cloudflared%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22edit%22%7D%5D&name=&accountId=*&zoneId=all) with at least:

- Account > Cloudflare One Connector: cloudflared: Read
    - Needed to get tunnel ip

Plus 1 or more of the following:

- Account > Zero Trust: Write
    - Needed if you want to update ZT Gateway IP
- Zone > DNS: Edit (for all zones you will update)
    - Needed to update DNS records
- Zone > Zone Settings: Edit
    - Needed to update Spectrum records

## Secrets and variables

Set these once per environment:

- `CF_API_TOKEN` (secret): API token with the scopes above.
- `CF_ACCOUNT_ID` (variable): your Cloudflare account ID.
- `CONFIG` (variable): JSON string matching the schema below.
- `GIT_HASH` (variable, optional): populated in the deploy pipeline if you want.

## CONFIG schema (JSON)

`CONFIG` is an array of tunnel configs. Each object can target Zero Trust locations, DNS records, Spectrum apps, or any combination.

Fields per tunnel object:

- `tunnel_id` (uuid string)
- `failure_email` (optional email) — receive an alert if the tunnel is down.
- `zt_locations` (optional array) — Zero Trust Gateway location IDs (uuid without hyphens).
- `dns_records` (optional array) — objects with:
    - `zone_id` (string)
    - `record_name` (optional array of FQDNs) — A records to keep updated
    - `spectrum_record_name` (optional array of FQDNs) — Spectrum app DNS names to update

Example `CONFIG` value:

```json
[
	{
		"tunnel_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"failure_email": "alerts@example.com",
		"zt_locations": ["11111111222233334444555566667777"],
		"dns_records": [
			{
				"zone_id": "0123456789abcdef0123456789abcdef",
				"record_name": ["edge.example.com", "api.example.com"],
				"spectrum_record_name": ["ssh.example.com"]
			}
		]
	}
]
```

Notes

- `zt_locations` IDs are technically UUIDs without hyphens.
- Spectrum entries require that a Spectrum app already exists for each listed `spectrum_record_name`; the worker rewrites `origin_direct` hostnames to the live connector IPs.
- DNS records are recreated on each run using the current connector IPs. Existing TTL, proxied flag, comment, settings, and tags are preserved when present.

## Setup

1. Install deps

```sh
npm ci
```

2. Configure secrets and variables (repeat per environment)

```sh
wrangler secret put CF_API_TOKEN
# Plaintext vars (pick one approach):
# a) Add under "vars" in wrangler.jsonc
# b) Or set at deploy time:
# wrangler deploy --var CF_ACCOUNT_ID=... --var CONFIG='[...]' --var GIT_HASH=optional
```

Paste the JSON from the example (or your own) when prompted for `CONFIG`.

3. (Optional) Regenerate Cloudflare runtime types

```sh
npm run build:types:cf
```

## Deploy

Use Wrangler to deploy the scheduled worker:

```sh
wrangler deploy
```

The cron trigger in `wrangler.jsonc` runs it every 5 minutes. `workers_dev` is disabled; you can attach a route if desired, but only the scheduled event is used.

## Local test

Run the scheduled handler locally:

```sh
wrangler dev --test-scheduled
```

This triggers the scheduled event once. Ensure your secrets are set locally (Wrangler will prompt if missing).

## Monitoring and failure behavior

- If no connectors are active for a tunnel, the worker throws. When `failure_email` is set for that tunnel, an email is sent and the run fails.
- Logs and traces are enabled via Wrangler settings; view them in Cloudflare Observability or `wrangler tail`.

## Troubleshooting

- 403 or scope errors: confirm the API token has the scopes listed above and is tied to the right account.
- DNS not updating: ensure `record_name` entries are fully qualified and exist (or let the worker create them) and that the zone ID matches.
- Spectrum not updating: confirm the Spectrum app already exists and the DNS name matches `spectrum_record_name` exactly.
- Zero Trust not updating: verify the location ID (strip hyphens) and that the token has Gateway write access.
