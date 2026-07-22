/**
 * Settings that belong to the machine rather than to any project.
 *
 * A project's `.happy-env.json` describes the site and travels with the repo.
 * These describe the computer it runs on — how the proxy is reached — and are
 * the same whichever project you're in, so they live beside the state rather
 * than in a repo where they'd be wrong for whoever cloned it.
 *
 * There's no command to write this. It's a rarely-touched escape hatch, and a
 * setter would imply otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from './compose.mjs';

export const MACHINE_CONFIG_FILE = path.join( STATE_DIR, 'config.json' );

// A loopback alias, not 127.0.0.1, so the proxy can sit beside whatever else
// already holds the usual address — another stack's proxy, or a local web
// server. Point a domain's wildcard DNS here and every project on it works with
// no further setup.
//
// This is also the address written into the LaunchDaemon that persists the
// alias, which is why it's worth naming rather than leaving as a literal.
export const DEFAULT_BIND_ADDRESS = '127.0.0.2';

const DEFAULTS = {
	// Set this to 127.0.0.1 to use `*.localhost` hosts instead, which resolve
	// with no DNS record and no network. That trades away the coexistence above:
	// on 127.0.0.1 the proxy contends with everything else that wants port 80.
	bindAddress: DEFAULT_BIND_ADDRESS,

	// The Traefik dashboard's host. Only reachable when it resolves to
	// `bindAddress`, so the default is useful exactly when bindAddress is
	// 127.0.0.1 and is a harmless dead route otherwise.
	dashboardHost: 'proxy.localhost',
};

/**
 * Read the machine's settings.
 *
 * @return {Object} Settings, with defaults applied.
 */
export function machineConfig() {
	let raw = {};

	if ( fs.existsSync( MACHINE_CONFIG_FILE ) ) {
		try {
			raw = JSON.parse( fs.readFileSync( MACHINE_CONFIG_FILE, 'utf8' ) );
		} catch ( error ) {
			throw new Error( `${ MACHINE_CONFIG_FILE } is not valid JSON: ${ error.message }` );
		}
	}

	return { ...DEFAULTS, ...raw };
}
