/**
 * What the environment leaves behind on a machine, and removing it.
 *
 * A stopped site keeps its container so a restart is seconds, and every
 * WordPress version a site has run keeps its own core volume and image. Only
 * `destroy` removes those, and it needs the project's config: a site whose repo
 * is gone, or that moved to a newer WordPress, leaves them behind for good.
 */

import { capture } from './docker.mjs';

// Removing a container costs a recreate on the next `start`. Its database and
// uploads are not touched.
export const STALE_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

const SITE_CONTAINER = /^hp-site-/;
const CORE_VOLUME = /^hp-site-.+_hp-core-/;

// The tags happy-env runs. `php8.4-apache` and a bare `cli` are not among them,
// and usually belong to wp-env.
const SITE_TAG = /^.+-php(\d+\.\d+)-apache$/;
const CLI_TAG = /^cli-php(\d+\.\d+)$/;

// A re-pull leaves the old image untagged, but its digest still names the repo.
const WORDPRESS_DIGEST = /^(docker\.io\/library\/)?wordpress@/;

// Only the fields used below. Full `docker inspect` output for a few dozen
// containers passes the 1 MB that spawnSync buffers, and is cut off.
const CONTAINER_FORMAT =
	'{"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}}},' +
	'"State":{"Status":{{json .State.Status}},"FinishedAt":{{json .State.FinishedAt}}},"Mounts":{{json .Mounts}}}';
const IMAGE_FORMAT = '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}}}';

const lines = ( result ) => ( result.stdout ? result.stdout.split( '\n' ) : [] );

/**
 * Runs `docker inspect` with a JSON format and parses one object per line.
 *
 * @param {string[]} args   Arguments before the IDs, e.g. `[ 'image', 'inspect' ]`.
 * @param {string}   format Go template producing one JSON object.
 * @param {string[]} ids    Objects to inspect.
 * @return {Object[]} Parsed objects.
 */
function inspect( args, format, ids ) {
	if ( ! ids.length ) {
		return [];
	}
	return lines( capture( 'docker', [ ...args, '--format', format, ...ids ] ) ).map( ( line ) =>
		JSON.parse( line )
	);
}

/**
 * Lists every container on the machine.
 *
 * @return {Object[]} Container details.
 */
function containers() {
	return inspect( [ 'inspect' ], CONTAINER_FORMAT, lines( capture( 'docker', [ 'ps', '-aq' ] ) ) );
}

/**
 * Finds stale site containers, and the core volumes and images nothing else uses.
 *
 * Only names happy-env itself creates are candidates. Anything a remaining
 * container uses is kept, whoever owns the container. The wp-cli image runs in
 * throwaway containers, so one is kept for each PHP version a remaining site
 * runs.
 *
 * @param {number} now Current time in milliseconds.
 * @return {Object} { containers, volumes, images }, each a list of { ref, label }.
 */
export function prunePlan( now = Date.now() ) {
	const all = containers();
	const name = ( container ) => container.Name.replace( /^\//, '' );

	const stale = all.filter(
		( container ) =>
			SITE_CONTAINER.test( name( container ) ) &&
			[ 'created', 'exited', 'dead' ].includes( container.State.Status ) &&
			now - Date.parse( container.State.FinishedAt ) > STALE_DAYS * DAY
	);
	const kept = all.filter( ( container ) => ! stale.includes( container ) );

	const usedImages = new Set( kept.map( ( container ) => container.Image ) );
	const usedVolumes = new Set(
		kept.flatMap( ( container ) =>
			container.Mounts.filter( ( mount ) => mount.Type === 'volume' ).map( ( mount ) => mount.Name )
		)
	);
	const sitePhp = new Set(
		kept
			.filter( ( container ) => SITE_CONTAINER.test( name( container ) ) )
			.map( ( container ) => container.Config.Image.split( ':' )[ 1 ]?.match( SITE_TAG )?.[ 1 ] )
			.filter( Boolean )
	);

	const volumes = lines( capture( 'docker', [ 'volume', 'ls', '-q' ] ) ).filter(
		( volume ) => CORE_VOLUME.test( volume ) && ! usedVolumes.has( volume )
	);

	const images = lines(
		capture( 'docker', [ 'image', 'ls', '--no-trunc', '--format', '{{json .}}' ] )
	).map( ( line ) => JSON.parse( line ) );

	const tags = images.filter( ( image ) => {
		if ( image.Repository !== 'wordpress' || usedImages.has( image.ID ) ) {
			return false;
		}
		const cli = image.Tag.match( CLI_TAG );
		return SITE_TAG.test( image.Tag ) || ( cli && ! sitePhp.has( cli[ 1 ] ) );
	} );

	const untaggedIds = images
		.filter( ( image ) => image.Repository === '<none>' && ! usedImages.has( image.ID ) )
		.map( ( image ) => image.ID );
	const untagged = inspect( [ 'image', 'inspect' ], IMAGE_FORMAT, untaggedIds ).filter( ( image ) =>
		image.RepoDigests?.some( ( digest ) => WORDPRESS_DIGEST.test( digest ) )
	);

	return {
		containers: stale.map( ( container ) => {
			const finished = Date.parse( container.State.FinishedAt );
			const days = Math.floor( ( now - finished ) / DAY );
			return {
				ref: name( container ),
				label: finished > 0 ? `${ name( container ) }  (stopped ${ days } days)` : `${ name( container ) }  (never started)`,
			};
		} ),
		volumes: volumes.map( ( volume ) => ( { ref: volume, label: volume } ) ),
		images: [
			...tags.map( ( image ) => ( { ref: `wordpress:${ image.Tag }`, label: `wordpress:${ image.Tag }` } ) ),
			...untagged.map( ( image ) => ( {
				ref: image.Id,
				label: `wordpress, untagged  (${ image.Id.replace( 'sha256:', '' ).slice( 0, 12 ) })`,
			} ) ),
		],
	};
}

/**
 * Removes everything a plan lists, and returns what could not be removed.
 *
 * Containers go first, so the volumes and images they held are free. Nothing
 * is forced: Docker refuses to remove an image another image builds on, and
 * that refusal is reported, not overridden.
 *
 * @param {Object} plan From `prunePlan()`.
 * @return {string[]} One line per failure.
 */
export function applyPrune( plan ) {
	const failures = [];

	const remove = ( args, items ) => {
		for ( const item of items ) {
			const result = capture( 'docker', [ ...args, item.ref ] );
			if ( result.code !== 0 ) {
				failures.push( `${ item.label }: ${ result.stderr }` );
			}
		}
	};

	remove( [ 'rm' ], plan.containers );
	remove( [ 'volume', 'rm' ], plan.volumes );
	remove( [ 'rmi' ], plan.images );

	return failures;
}
