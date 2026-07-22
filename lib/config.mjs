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
	wordpress: '6.9',
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

	// A site's root is the repo root unless it says otherwise — which is how one
	// repo can hold several sites that each have their own wp-content.
	const root = site.root ? path.resolve( repoRoot, site.root ) : repoRoot;

	if ( ! fs.existsSync( root ) ) {
		throw new Error(
			`Site "${ slug }" has root "${ site.root }", which does not exist.`
		);
	}

	// Themes and plugins default to whatever is on disk. A client repo tracks
	// only its own code, so that's usually exactly right — and for a repo that
	// also has vendor plugins checked out locally, mounting them is what you
	// want anyway.
	const themeRefs = site.themes ?? shared.themes;
	const themes = themeRefs
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
	const plugins = pluginRefs
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
	const muPlugins = discoverMounts( path.resolve( root, muPluginsRef ) );

	return {
		slug,
		host: site.host,
		root,
		php: shared.php,
		wordpress: shared.wordpress,
		themes,
		plugins,
		muPlugins,
		config: { ...( shared.config ?? {} ), ...( site.config ?? {} ) },
	};
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
		config: raw.config,
	};

	// `host` is shorthand for a single site named after the repo directory.
	const siteEntries = raw.sites
		? Object.entries( raw.sites )
		: [ [ path.basename( repoRoot ), { host: raw.host } ] ];

	const sites = siteEntries.map( ( [ slug, site ] ) =>
		resolveSite( slug, site, shared, repoRoot )
	);

	const hosts = new Set();
	for ( const site of sites ) {
		if ( hosts.has( site.host ) ) {
			throw new Error( `Two sites both claim the host "${ site.host }".` );
		}
		hosts.add( site.host );
	}

	return { configPath, repoRoot, sites };
}
