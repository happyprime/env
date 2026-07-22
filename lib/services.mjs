/**
 * The shared services — Traefik and MariaDB — that every project uses.
 *
 * These are started on demand and left running between projects. `happy-env
 * start` in any repo brings them up if they aren't already, so nobody has to
 * remember to start the proxy first.
 */

import path from 'node:path';

import { certExists, ensureCert } from './cert.mjs';
import { capture, isRunning, run, waitFor } from './docker.mjs';
import { CERT_DIR, MYSQL_PASSWORD, MYSQL_USER } from './compose.mjs';
import { DEFAULT_BIND_ADDRESS, machineConfig } from './machine.mjs';

const PACKAGE_ROOT = path.resolve( import.meta.dirname, '..' );

export const SERVICES_DIR = path.join( PACKAGE_ROOT, 'services' );
export const PLIST = path.join( PACKAGE_ROOT, 'com.happyprime.loopback-alias.plist' );
export const PROXY_CONTAINER = 'hp-proxy';
export const MYSQL_CONTAINER = 'hp-mysql';

/**
 * The shared compose file reads what varies from the environment: the
 * certificate directory lives outside the package, and the bind address is the
 * machine's to choose.
 *
 * @return {Object} Environment for compose invocations.
 */
function composeEnv() {
	const { bindAddress, dashboardHost } = machineConfig();

	return {
		...process.env,
		HAPPY_ENV_CERTS: CERT_DIR,
		HAPPY_ENV_BIND: bindAddress,
		HAPPY_ENV_DASHBOARD_HOST: dashboardHost,
	};
}

/**
 * Whether the address Traefik binds is actually available to bind.
 *
 * Only macOS needs the check. Linux routes the whole 127.0.0.0/8 to loopback
 * already, so any address in it is bindable with no setup — and asking
 * `ifconfig lo0` there would name an interface that doesn't exist and report a
 * missing alias that was never needed.
 *
 * @param {string} bindAddress Address the proxy binds.
 * @return {boolean} True when the proxy can bind it.
 */
function bindAddressReady( bindAddress ) {
	if ( process.platform !== 'darwin' || bindAddress === '127.0.0.1' ) {
		return true;
	}

	// macOS forgets a loopback alias on reboot unless the LaunchDaemon is
	// installed, so check rather than assume.
	return capture( 'ifconfig', [ 'lo0' ] ).stdout.includes( bindAddress );
}

/**
 * Walk up from a listening process to the one that actually owns the port.
 *
 * nginx and Apache share a single listening socket across a master and its
 * workers, and lsof reports the workers. Naming one of those is worse than
 * useless: killing a worker just makes the master start another, so the advice
 * looks like it didn't work.
 *
 * @param {string} pid  Process holding the socket.
 * @param {string} name Its command name.
 * @return {string} The topmost process of the same name.
 */
function masterPid( pid, name ) {
	let current = pid;

	// Bounded rather than `while (true)`: a ppid cycle shouldn't be able to hang
	// a start, and no real process tree is this deep.
	for ( let depth = 0; depth < 10; depth++ ) {
		const { code, stdout } = capture( 'ps', [ '-o', 'ppid=,comm=', '-p', current ] );
		if ( code !== 0 || ! stdout ) {
			break;
		}

		const [ parent ] = stdout.trim().split( /\s+/ );
		const parentCommand = capture( 'ps', [ '-o', 'comm=', '-p', parent ] ).stdout.trim();

		// Only climb while the parent is the same program. Stopping at the first
		// difference is what keeps this from walking all the way to launchd.
		if ( ! parent || parent === '1' || ! parentCommand.includes( name ) ) {
			break;
		}

		current = parent;
	}

	return current;
}

/**
 * Find a process outside Docker already listening on :80 or :443.
 *
 * The container scan cannot see these, and they are the more confusing case:
 * Valet, a stray Homebrew nginx, Apache left on from something else. OrbStack
 * does not report the collision — `compose up` succeeds, Traefik starts and
 * logs nothing wrong, and the published port simply never listens. Everything
 * says ready and the site is unreachable.
 *
 * @return {Object|null} { name, pid }, or null.
 */
function hostPortHolder() {
	// lsof is on macOS by default and on most Linux boxes, but it is not
	// guaranteed. Without it we just skip the check rather than block a start
	// that may well be fine.
	const { code, stdout } = capture( 'lsof', [
		'-nP',
		'-iTCP',
		'-sTCP:LISTEN',
		'-F',
		'pcn',
	] );

	if ( code !== 0 || ! stdout ) {
		return null;
	}

	let pid = null;
	let name = null;

	for ( const line of stdout.split( '\n' ) ) {
		const value = line.slice( 1 );

		if ( line.startsWith( 'p' ) ) {
			pid = value;
			name = null;
		} else if ( line.startsWith( 'c' ) ) {
			name = value;
		} else if ( line.startsWith( 'n' ) ) {
			// Addresses arrive as 127.0.0.1:80, *:443, [::1]:80 — the port is
			// whatever follows the last colon.
			const port = value.slice( value.lastIndexOf( ':' ) + 1 );

			if ( port === '80' || port === '443' ) {
				// Docker's own listener means a container holds the port, and
				// the container scan names it far more usefully than "OrbStack"
				// would.
				if ( /orbstack|docker|com\.docke/i.test( name ?? '' ) ) {
					continue;
				}

				return { name: name ?? 'A process', pid: masterPid( pid, name ) };
			}
		}
	}

	return null;
}

/**
 * Find another container already publishing :80 or :443 on the host.
 *
 * Only one thing can own those ports at a time. That is not the loopback alias
 * failing to do its job — it's that OrbStack allocates published ports by number
 * and routes to a single container regardless of which host IP the binding
 * names. Two proxies on 127.0.0.1 and 127.0.0.2 will both *start*, and then one
 * of them quietly answers for both addresses.
 *
 * Docker's own error for this ("port is already allocated") names an address
 * rather than the container, which sends you looking in the wrong place.
 *
 * @return {string|null} Container name, or null.
 */
function portConflict() {
	const ids = capture( 'docker', [ 'ps', '-q' ] ).stdout.split( '\n' ).filter( Boolean );
	if ( ! ids.length ) {
		return null;
	}

	const { stdout } = capture( 'docker', [
		'inspect',
		...ids,
		'--format',
		'{{.Name}}{{"\t"}}{{json .HostConfig.PortBindings}}',
	] );

	for ( const line of stdout.split( '\n' ) ) {
		const [ rawName, bindings ] = line.split( '\t' );
		if ( ! rawName || ! bindings ) {
			continue;
		}

		const name = rawName.replace( /^\//, '' );
		if ( name === PROXY_CONTAINER ) {
			continue;
		}

		try {
			const parsed = JSON.parse( bindings );
			if ( ! parsed ) {
				continue;
			}

			// The keys are container ports, and almost every web container
			// listens on :80 inside itself. Only the host side can collide, so
			// that is the side to read: a site published on 8889 takes nothing
			// from the proxy no matter what it calls the port internally.
			for ( const list of Object.values( parsed ) ) {
				for ( const binding of list ?? [] ) {
					if ( binding?.HostPort === '80' || binding?.HostPort === '443' ) {
						return name;
					}
				}
			}
		} catch {
			// Unparseable bindings tell us nothing; keep looking.
		}
	}

	return null;
}

/**
 * Whether MariaDB is up and accepting queries — running is not the same as
 * ready, and a site that connects too early fails its install.
 *
 * @return {boolean} True when queryable.
 */
export function mysqlReady() {
	if ( ! isRunning( MYSQL_CONTAINER ) ) {
		return false;
	}

	const { code } = capture( 'docker', [
		'exec',
		MYSQL_CONTAINER,
		'mariadb',
		`-u${ MYSQL_USER }`,
		`-p${ MYSQL_PASSWORD }`,
		'-e',
		'SELECT 1',
	] );

	return code === 0;
}

/**
 * Start Traefik and MariaDB if they aren't already running, and make sure the
 * certificate covers the hosts about to be served.
 *
 * @param {Object}   options       Options.
 * @param {string[]} options.hosts Hosts that must be covered.
 * @param {Function} options.log   Logger.
 * @return {Promise<void>}
 */
export async function ensureServices( { hosts = [], log = console.log } = {} ) {
	const running = isRunning( PROXY_CONTAINER ) && mysqlReady();
	const { bindAddress } = machineConfig();

	// Everything that can refuse the start goes first, before any of it has
	// changed something. Reissuing a certificate for a proxy that then turns out
	// to have nowhere to bind is work nobody asked for.
	if ( ! running ) {
		const holder = portConflict();
		if ( holder ) {
			throw new Error(
				`${ holder } is already using port 80/443, so the proxy can't start.\n\n` +
					'Only one proxy can hold those ports at a time — see "Sharing ports" in the\n' +
					'README for why the loopback alias does not get around this.\n\n' +
					`Stop it first:\n  docker stop ${ holder }\n` +
					( holder === 'altis-proxy'
						? '\nOr from the Altis project:\n  composer server stop --clean\n'
						: '' )
			);
		}

		const host = hostPortHolder();
		if ( host ) {
			throw new Error(
				`${ host.name } (pid ${ host.pid }) is listening on port 80/443, so the proxy\n` +
					'cannot bind — see "Sharing ports" in the README.\n\n' +
					'It holds the ports by number, so binding a different loopback address does\n' +
					'not avoid it. Nothing would report the collision: the proxy would start\n' +
					'clean and every site would simply be unreachable.\n\n' +
					( /nginx/i.test( host.name )
						? 'If this is Laravel Valet:\n  valet stop\n\nOtherwise stop it with:\n'
						: 'Stop it with:\n' ) +
					`  kill ${ host.pid }\n`
			);
		}

		if ( ! bindAddressReady( bindAddress ) ) {
			throw new Error(
				`The ${ bindAddress } loopback alias is missing, so Traefik cannot bind.\n` +
					'Add it for this session with:\n' +
					`  sudo ifconfig lo0 alias ${ bindAddress } up\n` +
					'Or persist it across reboots:\n' +
					`  sudo cp ${ PLIST } /Library/LaunchDaemons/\n` +
					'  sudo launchctl load -w /Library/LaunchDaemons/com.happyprime.loopback-alias.plist' +
					// The daemon has the default address written into it, so for
					// any other one it would alias the wrong address: right on
					// this run, and quietly wrong after the next reboot.
					( bindAddress === DEFAULT_BIND_ADDRESS
						? ''
						: `\n\nThe daemon aliases ${ DEFAULT_BIND_ADDRESS }. Edit your copy to say ${ bindAddress }.` )
			);
		}
	}

	// Before the early return, not after: a project bringing a domain the
	// certificate doesn't cover needs it reissued whether or not the services
	// happen to be up. Traefik reads the certificate once at startup and its
	// file provider watches the dynamic config, not the pem files that config
	// points at — so a reissue it doesn't restart for is a reissue it ignores.
	if ( hosts.length ) {
		if ( ensureCert( { hosts, log } ) && isRunning( PROXY_CONTAINER ) ) {
			log( 'Restarting the proxy to load the new certificate…' );
			capture( 'docker', [ 'restart', PROXY_CONTAINER ] );
		}
	} else if ( ! certExists() ) {
		// Nothing to derive names from and nothing already issued. Starting
		// anyway is the worst outcome available: Docker would create the empty
		// certificate directory itself, Traefik would fall back to its own
		// self-signed certificate, and every site would serve untrusted TLS from
		// a proxy that looks perfectly healthy.
		throw new Error(
			'There is no certificate yet, and no project here to derive one from.\n' +
				'Run `happy-env start` from a project instead — it generates the certificate\n' +
				'and starts these services itself.'
		);
	}

	if ( running ) {
		return;
	}

	log( 'Starting shared services (proxy, mysql)…' );

	const code = await run( 'docker', [ 'compose', 'up', '-d' ], {
		cwd: SERVICES_DIR,
		env: composeEnv(),
	} );
	if ( code !== 0 ) {
		throw new Error( 'Could not start the shared services.' );
	}

	const ready = await waitFor( () => mysqlReady(), { timeout: 90000 } );
	if ( ! ready ) {
		throw new Error( 'MariaDB did not become ready in time.' );
	}
}

/**
 * Stop the shared services.
 *
 * @return {Promise<number>} Exit code.
 */
export function stopServices() {
	return run( 'docker', [ 'compose', 'down' ], { cwd: SERVICES_DIR, env: composeEnv() } );
}

/**
 * Create a site's database if it doesn't exist.
 *
 * One MariaDB holds every project, so adding a site is a schema, not a
 * container.
 *
 * @param {string} name Database name.
 */
export function ensureDatabase( name ) {
	const { code, stderr } = capture( 'docker', [
		'exec',
		MYSQL_CONTAINER,
		'mariadb',
		`-u${ MYSQL_USER }`,
		`-p${ MYSQL_PASSWORD }`,
		'-e',
		`CREATE DATABASE IF NOT EXISTS \`${ name }\``,
	] );

	if ( code !== 0 ) {
		throw new Error( `Could not create database "${ name }": ${ stderr }` );
	}
}
