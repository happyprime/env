#!/usr/bin/env node
/**
 * happy-env — run a WordPress project locally.
 *
 *   happy-env start [site…]    Start this repo's sites (and shared services)
 *   happy-env stop [site…]     Stop this repo's sites
 *   happy-env reset [site…]    Drop the database and reinstall WordPress fresh
 *                              ( asks first; --yes / -y skips the prompt )
 *   happy-env destroy [site…]  Stop and delete containers, volumes, database
 *   happy-env status           What's running
 *   happy-env cli <site> …     Run wp-cli against a site
 *   happy-env cert [--only]    Reissue the certificate ( `start` does this for
 *                              you; --only drops names other projects added )
 *   happy-env services stop    Stop the shared proxy and mysql
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { regenerateCert } from '../lib/cert.mjs';
import { loadConfig } from '../lib/config.mjs';
import { siteDir, writeCompose, MYSQL_PASSWORD, MYSQL_USER } from '../lib/compose.mjs';
import { capture, dockerAvailable, isRunning, run, waitFor } from '../lib/docker.mjs';
import {
	ensureDatabase,
	ensureServices,
	MYSQL_CONTAINER,
	PROXY_CONTAINER,
	stopServices,
} from '../lib/services.mjs';

const log = ( ...args ) => console.log( ...args );
const fail = ( message ) => {
	console.error( `\nError: ${ message }\n` );
	process.exit( 1 );
};

/**
 * Ask a yes/no question and resolve to the answer.
 *
 * Only "y"/"yes" counts as consent; anything else, including a bare Enter, is a
 * no — the safe default for a destructive prompt. With no terminal to ask (a
 * script, a CI job) there's no one to answer, so it declines rather than block
 * forever waiting on a stdin that will never arrive; `--yes` is how those cases
 * say they meant it.
 *
 * @param {string} question Text to show, without the trailing prompt.
 * @return {Promise<boolean>} Whether the user said yes.
 */
function confirm( question ) {
	if ( ! process.stdin.isTTY ) {
		return Promise.resolve( false );
	}

	const rl = readline.createInterface( { input: process.stdin, output: process.stdout } );

	return new Promise( ( resolve ) => {
		rl.question( `${ question } [y/N] `, ( answer ) => {
			rl.close();
			resolve( /^y(es)?$/i.test( answer.trim() ) );
		} );
	} );
}

/**
 * This project's hosts, if you're standing in a project.
 *
 * For the commands that are about the machine rather than a site: they work
 * either way, and a project just tells them what it needs covering.
 *
 * @return {string[]} Hosts, or nothing.
 */
function projectHosts() {
	try {
		return loadConfig().sites.map( ( site ) => site.host );
	} catch {
		return [];
	}
}

/**
 * Compose args targeting one site's generated file.
 *
 * @param {Object} site Resolved site.
 * @return {string[]} Arguments for docker.
 */
function composeArgs( site ) {
	return [ 'compose', '-f', path.join( siteDir( site.slug ), 'docker-compose.yml' ) ];
}

/**
 * Run wp-cli against a site.
 *
 * @param {Object}   site    Resolved site.
 * @param {string[]} args    wp-cli arguments.
 * @param {boolean}  quiet   Capture output instead of streaming it.
 * @return {Object|Promise<number>} Captured result, or an exit code.
 */
function wp( site, args, quiet = false ) {
	const full = [ ...composeArgs( site ), 'run', '--rm', '-T', 'cli', 'wp', ...args ];
	return quiet ? capture( 'docker', full ) : run( 'docker', full );
}

/**
 * Select the sites named on the command line, or all of them.
 *
 * @param {Object[]} sites Resolved sites.
 * @param {string[]} names Requested slugs.
 * @return {Object[]} Selected sites.
 */
function select( sites, names ) {
	if ( ! names.length ) {
		return sites;
	}

	return names.map( ( name ) => {
		const site = sites.find( ( s ) => s.slug === name );
		if ( ! site ) {
			fail( `No site "${ name }" in this project. Available: ${ sites.map( ( s ) => s.slug ).join( ', ' ) }` );
		}
		return site;
	} );
}

/**
 * Bring up one site.
 *
 * @param {Object} site Resolved site.
 * @return {Promise<void>}
 */
async function startSite( site ) {
	log( `\n${ site.slug } → https://${ site.host }` );

	ensureDatabase( site.slug );

	// Bind-mounted, and every client repo gitignores it.
	fs.mkdirSync( path.join( site.root, 'uploads' ), { recursive: true } );

	writeCompose( site );

	const code = await run( 'docker', [ ...composeArgs( site ), 'up', '-d' ] );
	if ( code !== 0 ) {
		throw new Error( `Could not start ${ site.slug }.` );
	}

	// The image copies core into the volume on first boot; wp-cli can't run
	// until that lands.
	const container = `hp-site-${ site.slug }`;
	const ready = await waitFor(
		() =>
			capture( 'docker', [ 'exec', container, 'test', '-f', '/var/www/html/wp-load.php' ] )
				.code === 0,
		{ timeout: 120000 }
	);

	if ( ! ready ) {
		throw new Error( `${ site.slug }: WordPress files never appeared.` );
	}

	// Check before installing. wp-env's setup runs `wp core install`
	// unconditionally inside a pipefail chain, so against a database that
	// already has WordPress it aborts and silently skips the rest of its setup.
	//
	// Every wp-cli call spawns a container and loads WordPress, which on a big
	// site is seconds — so an already-installed site does exactly one of them
	// and stops. Its database already knows what's active.
	const installed = wp( site, [ 'core', 'is-installed' ], true ).code === 0;

	if ( ! installed ) {
		log( '  installing WordPress…' );
		const result = wp(
			site,
			[
				'core',
				'install',
				`--url=https://${ site.host }`,
				`--title=${ site.slug }`,
				'--admin_user=admin',
				'--admin_password=password',
				`--admin_email=admin@${ site.host }`,
				'--skip-email',
			],
			true
		);

		if ( result.code !== 0 ) {
			throw new Error(
				`${ site.slug }: install failed: ${ result.stderr || result.stdout }`
			);
		}

		// Only on a fresh install. On an existing database the active theme is
		// already decided, and overriding it would be wrong.
		if ( site.themes.length ) {
			log( `  activating theme ${ site.themes[ 0 ].name }…` );
			wp( site, [ 'theme', 'activate', site.themes[ 0 ].name ], true );
		}
	}

	const declared = site.plugins.filter( ( plugin ) => plugin.declared );
	if ( ! declared.length ) {
		return;
	}

	// One listing, then at most one install and one activate — rather than two
	// calls per plugin.
	const listed = wp( site, [ 'plugin', 'list', '--format=json' ], true );
	let present = new Map();
	try {
		present = new Map(
			JSON.parse( listed.stdout || '[]' ).map( ( plugin ) => [ plugin.name, plugin.status ] )
		);
	} catch {
		// An unreadable listing just means everything looks missing; install is
		// idempotent enough to survive that.
	}

	const missing = declared.filter(
		( plugin ) => plugin.type === 'install' && ! present.has( plugin.name )
	);
	if ( missing.length ) {
		log( `  installing ${ missing.length } plugin(s)…` );

		// `--version` is a flag on the command rather than on a plugin, so a
		// pinned plugin can't share a call with anything: every plugin named
		// alongside it would be held to that same version. Unpinned ones still
		// batch, which is the common case.
		const unpinned = missing.filter( ( plugin ) => ! plugin.version );

		if ( unpinned.length ) {
			wp( site, [ 'plugin', 'install', ...unpinned.map( ( p ) => p.source ) ], true );
		}

		for ( const plugin of missing.filter( ( p ) => p.version ) ) {
			wp( site, [ 'plugin', 'install', plugin.source, `--version=${ plugin.version }` ], true );
		}
	}

	const inactive = declared.filter( ( plugin ) => present.get( plugin.name ) !== 'active' );
	if ( inactive.length ) {
		log( `  activating ${ inactive.length } plugin(s)…` );

		// --skip-themes because a theme is allowed to depend on a plugin in this
		// very list, and loading it here is what makes that dependency circular:
		// the theme fatals for want of the plugin, wp-cli aborts, and the plugin
		// it was missing never activates. The theme loads normally on a real
		// request, by which time the plugin is active.
		const result = wp(
			site,
			[ 'plugin', 'activate', ...inactive.map( ( plugin ) => plugin.name ), '--skip-themes' ],
			true
		);

		// Worth stopping for. Silently carrying on prints a ready site that is
		// missing half its code, and the failure only resurfaces as whatever
		// breaks first in the browser.
		if ( result.code !== 0 ) {
			throw new Error(
				`${ site.slug }: could not activate ` +
					`${ inactive.map( ( plugin ) => plugin.name ).join( ', ' ) }: ` +
					( result.stderr || result.stdout )
			);
		}
	}
}

/**
 * happy-env start
 *
 * @param {string[]} names Site slugs.
 */
async function start( names ) {
	const { sites } = loadConfig();
	const selected = select( sites, names );

	await ensureServices( { hosts: selected.map( ( site ) => site.host ), log } );

	for ( const site of selected ) {
		await startSite( site );
	}

	log( '\nReady:' );
	for ( const site of selected ) {
		log( `  https://${ site.host }  (admin / password)` );
	}
	log( '' );
}

/**
 * happy-env stop
 *
 * @param {string[]} names Site slugs.
 */
async function stop( names ) {
	const { sites } = loadConfig();

	for ( const site of select( sites, names ) ) {
		const file = path.join( siteDir( site.slug ), 'docker-compose.yml' );
		if ( ! fs.existsSync( file ) ) {
			continue;
		}
		log( `Stopping ${ site.slug }…` );
		// `stop`, not `down`: keeping the containers means starting again is
		// seconds rather than a full recreate. `destroy` is the one that removes
		// things.
		await run( 'docker', [ ...composeArgs( site ), 'stop' ] );
	}
}

/**
 * happy-env destroy
 *
 * @param {string[]} names Site slugs.
 */
async function destroy( names ) {
	const { sites } = loadConfig();

	for ( const site of select( sites, names ) ) {
		const file = path.join( siteDir( site.slug ), 'docker-compose.yml' );

		if ( fs.existsSync( file ) ) {
			log( `Destroying ${ site.slug }…` );
			await run( 'docker', [ ...composeArgs( site ), 'down', '-v' ] );
		}

		// `down -v` only knows about the volume the current config names, but core
		// volumes are keyed by WordPress version, so any other version this site
		// has ever run is still sitting there.
		const stale = capture( 'docker', [
			'volume',
			'ls',
			'-q',
			'--filter',
			`name=hp-site-${ site.slug }_hp-core-`,
		] ).stdout
			.split( '\n' )
			.filter( Boolean );

		if ( stale.length ) {
			capture( 'docker', [ 'volume', 'rm', '-f', ...stale ] );
		}

		if ( isRunning( MYSQL_CONTAINER ) ) {
			capture( 'docker', [
				'exec',
				MYSQL_CONTAINER,
				'mariadb',
				`-u${ MYSQL_USER }`,
				`-p${ MYSQL_PASSWORD }`,
				'-e',
				`DROP DATABASE IF EXISTS \`${ site.slug }\``,
			] );
		}

		fs.rmSync( siteDir( site.slug ), { recursive: true, force: true } );
	}
}

/**
 * happy-env reset
 *
 * Clear a site's data and reinstall WordPress from scratch, keeping the
 * containers, core volume, and certificate. Faster than `destroy` followed by
 * `start`, and it never touches the shared services or other projects.
 *
 * @param {string[]} args Site slugs, optionally with `--yes`/`-y`.
 */
async function reset( args ) {
	const assumeYes = args.some( ( arg ) => arg === '--yes' || arg === '-y' );
	const names = args.filter( ( arg ) => arg !== '--yes' && arg !== '-y' );

	const { sites } = loadConfig();
	const selected = select( sites, names );

	// Dropping databases is the one thing here that loses work and can't be
	// undone, so confirm it — unless `--yes` already stood in for the answer.
	if ( ! assumeYes ) {
		const which = selected.map( ( site ) => site.slug ).join( ', ' );
		const ok = await confirm(
			`Drop the database and reinstall WordPress for ${ which }? This deletes all data.`
		);
		if ( ! ok ) {
			log( 'Nothing changed.' );
			return;
		}
	}

	// mysql has to be up to drop anything, and a stopped site is a fair thing to
	// reset — so bring the shared services up first, exactly as `start` does.
	await ensureServices( { hosts: selected.map( ( site ) => site.host ), log } );

	for ( const site of selected ) {
		log( `\nResetting ${ site.slug }…` );

		// Drop the whole schema rather than emptying tables: it clears anything a
		// plugin or a previous WordPress version left behind, and leaves
		// `startSite`'s `core is-installed` check reading false — which is what
		// makes it run a fresh install, activate the theme, and re-add the
		// declared plugins, the same path as a first boot. `startSite` recreates
		// the database (`ensureDatabase`) before it needs it.
		capture( 'docker', [
			'exec',
			MYSQL_CONTAINER,
			'mariadb',
			`-u${ MYSQL_USER }`,
			`-p${ MYSQL_PASSWORD }`,
			'-e',
			`DROP DATABASE IF EXISTS \`${ site.slug }\``,
		] );

		await startSite( site );
	}

	log( '\nReady:' );
	for ( const site of selected ) {
		log( `  https://${ site.host }  (admin / password)` );
	}
	log( '' );
}

/**
 * happy-env status
 */
function status() {
	log( `proxy  ${ isRunning( PROXY_CONTAINER ) ? 'running' : 'stopped' }` );
	log( `mysql  ${ isRunning( MYSQL_CONTAINER ) ? 'running' : 'stopped' }` );

	let config;
	try {
		config = loadConfig();
	} catch {
		return;
	}

	log( '' );
	for ( const site of config.sites ) {
		const up = isRunning( `hp-site-${ site.slug }` );
		log( `${ up ? 'running' : 'stopped' }  ${ site.slug.padEnd( 32 ) } https://${ site.host }` );
	}
}

/**
 * happy-env cli <site> …
 *
 * @param {string[]} args Site slug followed by wp-cli arguments.
 */
async function cli( args ) {
	const { sites } = loadConfig();

	// With one site the slug is optional.
	let slug = args[ 0 ];
	let rest = args.slice( 1 );

	if ( sites.length === 1 && ! sites.some( ( s ) => s.slug === slug ) ) {
		slug = sites[ 0 ].slug;
		rest = args;
	}

	const [ site ] = select( sites, [ slug ] );
	const code = await wp( site, rest );
	process.exit( code );
}

const [ command, ...args ] = process.argv.slice( 2 );

// `cert` only shells out to mkcert, so it works with Docker stopped — which is
// worth keeping, since a broken certificate is a plausible reason to be here
// before anything is running.
if ( command !== 'cert' && ! dockerAvailable() ) {
	fail( 'Docker is not running.' );
}

try {
	switch ( command ) {
		case 'cert':
			// The names come from the project you're standing in, unioned with
			// whatever the certificate already covers — so reissuing here never
			// costs another project its coverage. `--only` is the way to say you
			// meant to drop it.
			regenerateCert( { hosts: projectHosts(), only: args.includes( '--only' ), log } );
			break;
		case 'start':
			await start( args );
			break;
		case 'stop':
			await stop( args );
			break;
		case 'reset':
			await reset( args );
			break;
		case 'destroy':
			await destroy( args );
			break;
		case 'status':
			status();
			break;
		case 'cli':
			await cli( args );
			break;
		case 'services':
			if ( args[ 0 ] === 'stop' ) {
				await stopServices();
			} else {
				await ensureServices( { hosts: projectHosts(), log } );
			}
			break;
		default:
			log( fs.readFileSync( new URL( import.meta.url ), 'utf8' ).split( '*/' )[ 0 ].split( '\n' ).slice( 2, -1 ).map( ( l ) => l.replace( /^ \* ?/, '' ) ).join( '\n' ) );
			process.exit( command ? 1 : 0 );
	}
} catch ( error ) {
	fail( error.message );
}
