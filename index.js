"use strict";

require('dotenv').config();
const request = require('request');

request({
	method: 'GET',
	url: 'https://api.cloudflare.com/client/v4/zones/' + process.env.CLOUDFLARE_ZONEIDENTIFIER + '/dns_records',
	headers: {
		Authorization: 'Bearer ' + process.env.CLOUDFLARE_APIKEY,
		per_page: '100'
	}
}, function (error, response, body) {
	if (error) {
		throw error;
	} else if (response.statusCode != 200) {
		throw new Error('cloudflare get dns records http ' + response.statusCode);
	} else {
		const json = JSON.parse(body);
		if (json.success) {
			json.result.forEach(function (dnsRecord) {
				if (dnsRecord.name == process.env.CLOUDFLARE_UPDATEFOR) {
					if (dnsRecord.type == 'A' || dnsRecord.type == 'AAAA') {
						updateCloudflare(dnsRecord);
					}
				}
			});
		}
	}
});


function updateCloudflare(dnsRecord) {
	if (dnsRecord) {
		const getIpUrl = dnsRecord.type == 'A' ? 'https://ipv4bot.whatismyipaddress.com' : 'https://ipv6bot.whatismyipaddress.com';
		request.get({
			url: getIpUrl,
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36'
			}
		}, function (error1, response1, body1) {
			if (error1) {
				throw error1
			} else if (response1.statusCode != 200) {
				throw new Error('ip address request http ' + response1.statusCode);
			} else {
				const validIp = /((^\s*((([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))\s*$)|(^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$))/;
				if (validIp.test(body1)) {
					const currentIp = validIp.exec(body1)[0];
					request.put({
						url: 'https://api.cloudflare.com/client/v4/zones/' + process.env.CLOUDFLARE_ZONEIDENTIFIER + '/dns_records/' + dnsRecord.id,
						headers: {
							'Content-Type': 'application/json',
							Authorization: 'Bearer ' + process.env.CLOUDFLARE_APIKEY
						},
						body: {
							type: dnsRecord.type,
							name: dnsRecord.name,
							content: currentIp,
							ttl: 1,
							proxied: true
						},
						json: true
					}, function (error2, response2, body2) {
						if (error2) {
							throw error2
						} else if (response2.statusCode != 200) {
							throw new Error('setting ip address http ' + response2.statusCode);
						}
					});
				}
			}
		});
	}
}