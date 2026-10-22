/**
 * Reads .happy-env.json and resolves it into concrete site definitions.
 *
 * A repo is a wp-content directory, so most of what an environment needs can be
 * read off disk rather than declared. The config file carries what can't be
 * inferred — the hostname, and any version or plugin choices.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.happy-env.json';

const DEFAULTS = {
	// Matches the phpVersion every project's .wp-env.json already pins.
	php: '8.4',
	// A minor tag tracks patch releases; a full version pins exactly.
	wordpress: '7.1',
};

// These ship with the core in the image, so mounting a site's copies would just
// shadow identical files.
const isDefaultTheme = ( name ) => /^twenty(twenty)?[a-z]*$/i.test( name );

/**
 * Walk up from a directory looking for .happy-env.json, so the CLI works from
 * anywhere inside a repo.
 *
 * @param {string} from Directory to start from.
 * @return {string|null} Absolute path to the config file, or null.
 */
export function findConfig( from = process.cwd() ) {
	let dir = path.resolve( from );

	while ( true ) {
		const candidate = path.join( dir, CONFIG_FILE );
		if ( fs.existsSync( candidate ) ) {
			return candidate;
		}

		const parent = path.dirname( dir );
		if ( parent === dir ) {
			return null;
		}
		dir = parent;
	}
}

/**
 * List a directory's entries as mountable sources.
 *
 * Symlinks are resolved to their real path. Projects routinely symlink shared
 * code out to sibling workspace repos, and a symlink pointing at an absolute
 * host path means nothing inside a container — it has to be mounted at the path
 * it actually resolves to.
 *
 * @param {string}   dir    Directory to list.
 * @param {Function} filter Receives the entry name; return false to skip.
 * @return {Object[]} Entries as { name, source }.
 */
function discoverMounts( dir, filter = () => true ) {
	if ( ! fs.existsSync( dir ) ) {
		return [];
	}

	return fs
		.readdirSync( dir )
		.sort()
		.filter( filter )
		.map( ( name ) => ( { name, source: fs.realpathSync( path.join( dir, name ) ) } ) )
		.filter( ( entry ) => fs.existsSync( entry.source ) );
}

/**
 * Parse a plugin reference.
 *
 * Accepts a wordpress.org slug ('woocommerce'), a versioned slug
 * ('woocommerce@10.7.0'), a zip URL, or a local path ('./plugins/thing').
 * Local paths are mounted rather than installed, since they're code that should
 * stay editable.
 *
 * A pinned version is kept apart from what identifies the plugin, rather than
 * pre-baked into a `--version=` argument: that flag applies to a whole wp-cli
 * command, so a caller batching two pinned plugins into one call would give both
 * the same version. Only the caller can see that, so only the caller can avoid
 * it.
 *
 * @param {string} ref  Plugin reference.
 * @param {string} root Site root, for resolving local paths.
 * @return {Object} A mount or install descriptor.
 */
function parsePlugin( ref, root ) {
	if ( ref.startsWith( '.' ) || ref.startsWith( '/' ) ) {
		const source = fs.realpathSync( path.resolve( root, ref ) );
		return { type: 'mount', source, name: path.basename( source ) };
	}

	if ( ref.startsWith( 'http://' ) || ref.startsWith( 'https://' ) ) {
		return { type: 'install', source: ref, name: path.basename( ref, '.zip' ) };
	}

	const [ slug, version ] = ref.split( '@' );
	return { type: 'install', source: slug, name: slug, version };
}

// Where the container keeps WordPress, and the directory relative mount
// targets are measured from.
const DOCROOT = '/var/www/html';
const CONTENT_DIR = `${ DOCROOT }/wp-content`;

/**
 * Resolve a site's `core` — a full WordPress checkout to run instead of the
 * image's copy — to an absolute path, or null when the site doesn't set one.
 *
 * @param {string} slug     Site slug, for error messages.
 * @param {Object} site     Site config.
 * @param {Object} shared   Repo-level config the site inherits.
 * @param {string} repoRoot Absolute repo root.
 * @return {string|null} Real path of the checkout.
 */
function resolveCore( slug, site, shared, repoRoot ) {
	const ref = site.core ?? shared.core;
	if ( ! ref ) {
		return null;
	}

	const resolved = path.resolve( repoRoot, ref );

	if ( ! fs.existsSync( path.join( resolved, 'wp-settings.php' ) ) ) {
		throw new Error(
			`Site "${ slug }" has core "${ ref }", but ${ resolved } is not a WordPress checkout (no wp-settings.php).`
		);
	}

	return fs.realpathSync( resolved );
}

/**
 * Refuse a mount that would make Docker create its mountpoint inside a core
 * checkout.
 *
 * With core bind-mounted, every mount under the docroot lands in the checkout
 * on the host. Docker creates a missing mountpoint as an empty directory, so a
 * mount over a file that isn't there leaves a stray directory in the repo and
 * then fails to mount at all. The only safe target is one that already exists
 * and is the same kind of thing as the source.
 *
 * @param {string} slug          Site slug, for error messages.
 * @param {string} ref           Mount source as written.
 * @param {string} source        Real path of the source.
 * @param {string} containerPath Absolute path in the container.
 * @param {string} core          Real path of the checkout.
 */
function assertMountExistsInCore( slug, ref, source, containerPath, core ) {
	if ( ! containerPath.startsWith( `${ DOCROOT }/` ) ) {
		return;
	}

	const inCore = path.join( core, path.posix.relative( DOCROOT, containerPath ) );
	const relative = path.relative( core, inCore );

	if ( ! fs.existsSync( inCore ) ) {
		throw new Error(
			`Site "${ slug }" mounts "${ ref }" over ${ relative }, which does not exist in ${ core }.\n` +
				'A mount into a core checkout must replace something that is already there; Docker would otherwise create it in the repo.'
		);
	}

	const sourceIsDir = fs.statSync( source ).isDirectory();
	const targetIsDir = fs.statSync( inCore ).isDirectory();

	if ( sourceIsDir !== targetIsDir ) {
		throw new Error(
			`Site "${ slug }" mounts "${ ref }" (a ${ sourceIsDir ? 'directory' : 'file' }) over ${ relative }, which is a ${ targetIsDir ? 'directory' : 'file' }.`
		);
	}
}

/**
 * Normalize and validate a hostname.
 *
 * Hostnames are case-insensitive and may carry a trailing root dot, so the same
 * name can be written several ways. Routing and certificate naming both compare
 * as text, so they are folded here once rather than in each place that cares.
 *
 * Anything that isn't a hostname is rejected now rather than interpolated into
 * a Traefik rule, where a stray backtick would end the rule early and route the
 * site somewhere nobody asked for.
 *
 * @param {unknown} value Hostname as written.
 * @param {string}  slug  Site slug, for the error message.
 * @param {string}  key   Config key the value came from, for the error message.
 * @return {string} Normalized hostname.
 */
function normalizeHost( value, slug, key ) {
	if ( typeof value !== 'string' ) {
		throw new Error( `Site "${ slug }" has a non-string ${ key }.` );
	}

	const host = value.trim().toLowerCase().replace( /\.$/, '' );

	// Letters, digits and hyphens per label, at least two labels, no leading or
	// trailing hyphen. Deliberately narrower than the RFCs: this is a name the
	// developer types into a config file, not one arriving off the wire.
	if ( ! /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test( host ) ) {
		throw new Error(
			`Site "${ slug }" has ${ key } "${ value }", which is not a hostname.`
		);
	}

	return host;
}

/**
 * Resolve one site entry into everything the compose renderer needs.
 *
 * @param {string} slug     Site slug; names the database and container.
 * @param {Object} site     Site config.
 * @param {Object} shared   Repo-level config the site inherits.
 * @param {string} repoRoot Absolute repo root.
 * @return {Object} Resolved site.
 */
function resolveSite( slug, site, shared, repoRoot ) {
	if ( ! site.host ) {
		throw new Error( `Site "${ slug }" is missing a host.` );
	}

	const host = normalizeHost( site.host, slug, 'host' );
	const aliases = site.aliases ?? [];

	if ( ! Array.isArray( aliases ) ) {
		throw new Error( `Site "${ slug }" has aliases that are not a list.` );
	}

	// Traefik matches one rule per router, so every name a container must answer
	// for has to be in that rule. One host is the common case; a repo running a
	// WordPress network across several domains needs the rest named too. `host`
	// stays canonical — it is the URL WordPress is configured with and the one
	// printed on start — and the aliases only have to route. Which site answers
	// on an alias is the network's business, not the proxy's.
	const hosts = [
		...new Set( [
			host,
			...aliases.map( ( alias ) => normalizeHost( alias, slug, 'alias' ) ),
		] ),
	];

	// A site's root is the repo root unless it says otherwise — which is how one
	// repo can hold several sites that each have their own wp-content.
	const root = site.root ? path.resolve( repoRoot, site.root ) : repoRoot;

	if ( ! fs.existsSync( root ) ) {
		throw new Error(
			`Site "${ slug }" has root "${ site.root }", which does not exist.`
		);
	}

	const core = resolveCore( slug, site, shared, repoRoot );

	if ( core ) {
		// The checkout is wp-content, so anything that would build one is a
		// contradiction rather than an addition.
		const conflicting = [ 'root', 'themes', 'plugins', 'muPlugins' ].filter(
			( key ) => site[ key ] !== undefined || ( key !== 'root' && shared[ key ] !== undefined )
		);

		if ( conflicting.length ) {
			throw new Error(
				`Site "${ slug }" sets "core" and ${ conflicting.map( ( k ) => `"${ k }"` ).join( ', ' ) }. ` +
					'A core checkout supplies wp-content, so themes, plugins, muPlugins and root cannot be set with it.'
			);
		}
	}

	// Themes and plugins default to whatever is on disk. A client repo tracks
	// only its own code, so that's usually exactly right — and for a repo that
	// also has vendor plugins checked out locally, mounting them is what you
	// want anyway.
	const themeRefs = site.themes ?? shared.themes;
	const themes = core
		? []
		: themeRefs
		? themeRefs.map( ( ref ) => {
				const source = fs.realpathSync(
					path.resolve( root, ref.includes( '/' ) ? ref : path.join( 'themes', ref ) )
				);
				return { name: path.basename( source ), source };
		  } )
		: discoverMounts(
				path.join( root, 'themes' ),
				( name ) => ! isDefaultTheme( name ) && ! name.endsWith( '.php' )
		  );

	// Declared plugins are an intent to use, so they get installed and activated.
	// Discovered ones are only made available — whether they're active is the
	// database's business, and force-activating them would silently override a
	// site's real state.
	const pluginRefs = site.plugins ?? shared.plugins;
	const plugins = core
		? []
		: pluginRefs
		? pluginRefs.map( ( ref ) => ( { declared: true, ...parsePlugin( ref, root ) } ) )
		: discoverMounts(
				path.join( root, 'plugins' ),
				( name ) => ! name.endsWith( '.php' )
		  ).map( ( entry ) => ( { declared: false, type: 'mount', ...entry } ) );

	// mu-plugins are mounted entry by entry rather than as one directory. A
	// single bind mount of the whole directory would leave any symlinks inside
	// it dangling, and nothing could be layered in beside them without Docker
	// writing mountpoints into the real repo.
	const muPluginsRef = site.muPlugins ?? shared.muPlugins ?? './mu-plugins';
	const muPlugins = core ? [] : discoverMounts( path.resolve( root, muPluginsRef ) );

	// Anything else wp-content needs that isn't a theme, plugin, or upload —
	// in practice a composer `vendor` directory, which plugins in the same repo
	// autoload from wp-content rather than from their own directory. A target
	// is relative to wp-content; an absolute one names a path anywhere in the
	// container, which is how an Apache or PHP config file gets in.
	const mounts = Object.entries( site.mounts ?? shared.mounts ?? {} ).map(
		( [ source, target ] ) => {
			const resolved = path.resolve( root, source );

			if ( ! fs.existsSync( resolved ) ) {
				throw new Error(
					`Site "${ slug }" mounts "${ source }", which does not exist.\n` +
						( source.includes( 'vendor' )
							? 'Run `composer install` first.'
							: `Looked in ${ resolved }.` )
				);
			}

			const realSource = fs.realpathSync( resolved );
			const containerPath = path.posix.resolve( CONTENT_DIR, target );

			if ( core ) {
				assertMountExistsInCore( slug, source, realSource, containerPath, core );
			}

			return { source: realSource, target: containerPath };
		}
	);

	// A missing uploads file can fall back to a production origin. A per-site
	// value wins over the repo-level one; neither is the common case, so both
	// are usually absent.
	const uploadsFallback = normalizeFallback(
		site.uploads?.fallback ?? shared.uploads?.fallback ?? null,
		slug
	);

	return {
		slug,
		host,
		hosts,
		root,
		core,
		php: shared.php,
		wordpress: shared.wordpress,
		themes,
		plugins,
		muPlugins,
		mounts,
		config: { ...( shared.config ?? {} ), ...( site.config ?? {} ) },
		uploadsFallback,
	};
}

/**
 * Normalize an uploads fallback origin.
 *
 * It's the scheme-and-host a missing upload is proxied from, so a trailing
 * slash would only double up when `/wp-content/uploads/…` is appended. Anything
 * that isn't an http(s) URL is rejected here rather than baked into an Apache
 * config that then fails to parse and takes the whole site down.
 *
 * @param {string|null} value Raw fallback value.
 * @param {string}      slug  Site slug, for the error message.
 * @return {string|null} Normalized origin, or null.
 */
function normalizeFallback( value, slug ) {
	if ( ! value ) {
		return null;
	}

	if ( ! /^https?:\/\//.test( value ) ) {
		throw new Error(
			`Site "${ slug }" has uploads.fallback "${ value }", which must be an http(s) URL.`
		);
	}

	return value.replace( /\/+$/, '' );
}

/**
 * Load and resolve a project's configuration.
 *
 * @param {string} [from] Directory to search from.
 * @return {Object} { configPath, repoRoot, sites }
 */
export function loadConfig( from = process.cwd() ) {
	const configPath = findConfig( from );

	if ( ! configPath ) {
		throw new Error( `No ${ CONFIG_FILE } found here or in any parent directory.` );
	}

	let raw;
	try {
		raw = JSON.parse( fs.readFileSync( configPath, 'utf8' ) );
	} catch ( error ) {
		throw new Error( `${ configPath } is not valid JSON: ${ error.message }` );
	}

	const repoRoot = path.dirname( configPath );

	if ( raw.host && raw.sites ) {
		throw new Error(
			`${ configPath } sets both "host" and "sites". Use "host" for a single site, "sites" for several.`
		);
	}

	if ( ! raw.host && ! raw.sites ) {
		throw new Error(
			`${ configPath } needs either "host" (single site) or "sites" (several).`
		);
	}

	const shared = {
		php: raw.php ?? DEFAULTS.php,
		wordpress: raw.wordpress ?? DEFAULTS.wordpress,
		themes: raw.themes,
		plugins: raw.plugins,
		muPlugins: raw.muPlugins,
		mounts: raw.mounts,
		config: raw.config,
		uploads: raw.uploads,
		core: raw.core,
	};

	// `host` is shorthand for a single site named after the repo directory.
	const siteEntries = raw.sites
		? Object.entries( raw.sites )
		: [ [ path.basename( repoRoot ), { host: raw.host, aliases: raw.aliases } ] ];

	const sites = siteEntries.map( ( [ slug, site ] ) =>
		resolveSite( slug, site, shared, repoRoot )
	);

	// Every routed name, not just the canonical one: two sites claiming the same
	// alias would generate two Traefik rules matching the same Host header, and
	// whichever router loaded first would quietly win.
	const claimed = new Map();
	for ( const site of sites ) {
		for ( const host of site.hosts ) {
			const owner = claimed.get( host );
			if ( owner ) {
				throw new Error(
					`Sites "${ owner }" and "${ site.slug }" both claim the host "${ host }".`
				);
			}
			claimed.set( host, site.slug );
		}
	}

	return { configPath, repoRoot, sites };
}
