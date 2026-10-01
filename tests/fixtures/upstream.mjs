import { createServer, request } from 'node:http';

// This variable is supplied by the container runtime, not the Turbo task environment.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const endpoint = process.env.OBJECTSTORE_ENDPOINT;

await fetch(`${endpoint}/boot`);

// Keep a real TCP container boundary while the test controls responses on the host.
createServer((incoming, outgoing) => {
	const upstream = request(
		`${endpoint}${incoming.url}`,
		{
			method: incoming.method,
			headers: incoming.headers,
		},
		(response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(outgoing);
			response.on('error', () => outgoing.destroy());
		},
	);

	incoming.pipe(upstream);
	outgoing.on('close', () => upstream.destroy());
	upstream.on('error', () => outgoing.destroy());
}).listen(8317, '0.0.0.0');
