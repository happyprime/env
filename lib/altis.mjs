/**
 * Runs an Altis Local Server project behind the shared proxy.
 *
 * Under OrbStack only one proxy can hold :80/:443, and Local Server publishes
 * its own on every interface. Its containers already carry Traefik labels, so
 * instead of taking turns, the shared proxy joins Local Server's network and
 * routes them itself. Local Server still owns the stack: this starts and stops
 * the containers it generated and leaves everything else to `composer server`.
 */

import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

import { capture, isRunning, run } from './docker.mjs';
import { machineConfig } from './machine.mjs';
import { ensureServices, mailHostFor, PROXY_CONTAINER, runningMailHost } from './services.mjs';

// Local Server's shared network. Its PHP container reaches the project's own
// hosts through `external_links` to whatever answers as `proxy` there, which is
// how S3 Uploads and Tachyon requests from PHP get routed.
const NETWORK = 'proxy';

/**
 * Resolves an Altis project's hosts the way Local Server derives them.
 *
 * Mirrors `get_project_subdomain()` and `get_project_tld()` in Local Server's
 * Command class: the same config keys, defaults, and character filter. If the
 * two drift, the certificate and DNS check cover hosts that nothing answers on.
 *
 * @param {string} repoRoot Absolute repo root, where composer.json lives.
 * @return {Object} { name, host, hosts, composeFile }
 */
export function resolveAltis( repoRoot ) {
	let composer;
	try {
		composer = JSON.parse( fs.readFileSync( path.join( repoRoot, 'composer.json' ), 'utf8' ) );
	} catch ( error ) {
		throw new Error( `"altis" needs a readable composer.json beside .happy-env.json: ${ error.message }` );
	}

	const config = composer.extra?.altis?.modules?.[ 'local-server' ] ?? {};
	const name = String( config.name ?? path.basename( repoRoot ) ).replace( /[^A-Za-z0-9_-]/g, '' );
	const host = `${ name }.${ config.tld ?? 'altis.dev' }`.toLowerCase();
	const domains = ( config.domains ?? [] ).map( ( domain ) => domain.trim().toLowerCase() ).filter( Boolean );

	return {
		name,
		host,
		hosts: [ host, `s3-${ host }`, ...domains ],
		composeFile: path.join( repoRoot, 'vendor', 'docker-compose.yml' ),
	};
}

/**
 * The environment Local Server runs compose with.
 *
 * The generated file names its containers but not its project, and compose
 * would otherwise take the project name from the `vendor` directory and collide
 * with every container Local Server already made.
 *
 * @param {Object} altis Resolved Altis project.
 * @return {Object} Environment for compose invocations.
 */
function composeEnv( altis ) {
	return { ...process.env, COMPOSE_PROJECT_NAME: altis.name };
}

/**
 * Lists the hosts that don't resolve to the proxy.
 *
 * `*.altis.dev` is public DNS pointing at 127.0.0.1. With the proxy on the
 * default loopback alias, each Altis host needs an `/etc/hosts` line.
 *
 * @param {string[]} hosts       Hostnames.
 * @param {string}   bindAddress Address the proxy binds.
 * @return {Promise<string[]>} Hosts that resolve elsewhere or not at all.
 */
async function unresolved( hosts, bindAddress ) {
	const addresses = await Promise.all(
		hosts.map( ( host ) => dns.lookup( host ).then( ( result ) => result.address, () => null ) )
	);

	return hosts.filter( ( host, index ) => addresses[ index ] !== bindAddress );
}

/**
 * Starts an Altis project's containers behind the shared proxy.
 *
 * @param {Object}   altis Resolved Altis project.
 * @param {Function} log   Logger.
 * @return {Promise<string[]>} Hosts that don't resolve to the proxy.
 */
export async function startAltis( altis, log = console.log ) {
	// Local Server's own first `start` writes the compose file and creates the
	// network, then stops at its proxy while this one holds the ports.
	const hasNetwork = capture( 'docker', [ 'network', 'inspect', NETWORK ] ).code === 0;

	if ( ! fs.existsSync( altis.composeFile ) || ! hasNetwork ) {
		throw new Error(
			'Run `composer server start` once first. It writes vendor/docker-compose.yml and\n' +
				'creates the proxy network, then stops at "Could not start traefik proxy" while\n' +
				'this proxy holds the ports. That error is expected.'
		);
	}

	await ensureServices( {
		hosts: altis.hosts,
		// Altis brings its own mail catcher. Deriving the inbox from an Altis host
		// would move it to a name that resolves to 127.0.0.1.
		mailHost: runningMailHost() ?? mailHostFor(),
		log,
	} );

	// Recreating the proxy drops this, so check on every start.
	const networks = capture( 'docker', [
		'inspect',
		PROXY_CONTAINER,
		'--format',
		'{{json .NetworkSettings.Networks}}',
	] ).stdout;

	if ( ! Object.hasOwn( JSON.parse( networks || '{}' ), NETWORK ) ) {
		const { code, stderr } = capture( 'docker', [
			'network',
			'connect',
			'--alias',
			'proxy',
			NETWORK,
			PROXY_CONTAINER,
		] );

		if ( code !== 0 ) {
			throw new Error( `Could not connect the proxy to the ${ NETWORK } network: ${ stderr }` );
		}
	}

	log( `\n${ altis.name } → https://${ altis.host }` );

	const code = await run( 'docker', [ 'compose', '-f', altis.composeFile, 'up', '-d' ], {
		env: composeEnv( altis ),
	} );

	if ( code !== 0 ) {
		throw new Error( `Could not start ${ altis.name }.` );
	}

	return unresolved( altis.hosts, machineConfig().bindAddress );
}

/**
 * Stops an Altis project's containers.
 *
 * @param {Object} altis Resolved Altis project.
 * @return {Promise<number>} Exit code.
 */
export function stopAltis( altis ) {
	return run( 'docker', [ 'compose', '-f', altis.composeFile, 'stop' ], { env: composeEnv( altis ) } );
}

/**
 * Reports whether an Altis project's web server is running.
 *
 * @param {Object} altis Resolved Altis project.
 * @return {boolean} True when running.
 */
export function altisRunning( altis ) {
	return isRunning( `${ altis.name }-nginx` );
}
