/**
 * Renders a resolved site into a docker compose file.
 *
 * The generated file is written under ~/.happy-env rather than into the project
 * repo — it's a build artifact, and client repos shouldn't carry one.
 *
 * It's emitted as JSON. YAML is a superset of JSON, so docker compose reads it
 * happily, and we avoid hand-escaping PHP snippets into YAML block scalars.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NETWORK = 'hp-env';
export const MYSQL_HOST = 'hp-mysql';
export const MYSQL_USER = 'root';
export const MYSQL_PASSWORD = 'password';

// Everything machine-global lives here rather than in the package directory.
// Once this is installed as a dependency the package lives in node_modules,
// which npm is free to wipe on any reinstall — no place for a certificate, and
// no place to have one copy per project either.
export const STATE_DIR = path.join( os.homedir(), '.happy-env' );
export const CERT_DIR = path.join( STATE_DIR, 'certs' );

/**
 * Where a site's generated compose file lives.
 *
 * @param {string} slug Site slug.
 * @return {string} Absolute path to the site's directory.
 */
export function siteDir( slug ) {
	return path.join( STATE_DIR, 'sites', slug );
}

/**
 * Name the volume holding a site's WordPress core.
 *
 * The version is part of the name deliberately. The image's entrypoint copies
 * core in only when the volume has none — its one test is `if [ ! -e index.php
 * ] && [ ! -e wp-includes/version.php ]` — and never looks at the version again
 * either way. So a single volume would leave `"wordpress": "6.8"` still serving
 * whatever booted first, while every other signal (the image tag, the config)
 * says otherwise. That is the worst kind of wrong: silent, and precisely
 * backwards when the reason you pinned a version was to test against it.
 *
 * Keying the volume to the version makes switching pick up the right core by
 * construction, and switching back is instant because the old one is still
 * there.
 *
 * The key is the version as written, so `"wordpress": "6.9"` is one volume even
 * though the tag behind it moves with each patch. An existing site therefore
 * stays on the patch it first booted; `happy-env destroy` is what picks up a
 * newer one.
 *
 * @param {Object} site Resolved site.
 * @return {string} Volume name.
 */
export function coreVolume( site ) {
	const version = String( site.wordpress ).replace( /[^a-zA-Z0-9_.-]/g, '-' );
	return `hp-core-${ site.slug }-${ version }`;
}

/**
 * Build the PHP that configures the site.
 *
 * This is why no mu-plugin is needed. The official image's wp-config.php runs
 * `if ($configExtra = getenv_docker('WORDPRESS_CONFIG_EXTRA', '')) {
 * eval($configExtra); }` just before it requires wp-settings.php, so this runs
 * as part of wp-config — far earlier than any plugin could, and, because core
 * has yet to be loaded, early enough that it derives WP_CONTENT_URL and
 * WP_PLUGIN_URL from the right site URL.
 *
 * Being eval'd, it must be bare PHP with no opening tag, and a syntax error
 * here breaks both the site and wp-cli.
 *
 * Terminating TLS at Traefik needs no handling: the image's wp-config already
 * sets $_SERVER['HTTPS'] from X-Forwarded-Proto, because reverse proxying is
 * the norm in containers.
 *
 * @param {Object} site Resolved site.
 * @return {string} PHP source.
 */
function configExtra( site ) {
	const lines = [
		'/* Managed by @happyprime/env. */',
		`define( 'WP_HOME', 'https://${ site.host }' );`,
		`define( 'WP_SITEURL', 'https://${ site.host }' );`,
	];

	for ( const [ key, value ] of Object.entries( site.config ) ) {
		let literal;
		if ( typeof value === 'string' ) {
			// Backslash first, or escaping the quotes would escape those
			// backslashes too. Both matter: inside a PHP single-quoted string
			// they're the only two characters that do, and a value ending in a
			// backslash would otherwise escape its own closing quote and take
			// wp-config — and so wp-cli — down with it.
			literal = `'${ value.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) }'`;
		} else if ( typeof value === 'boolean' ) {
			literal = value ? 'true' : 'false';
		} else {
			literal = String( value );
		}
		lines.push( `define( '${ key }', ${ literal } );` );
	}

	return lines.join( '\n' ) + '\n';
}

/**
 * Volume mounts shared by the site's WordPress and wp-cli containers.
 *
 * Core lives in a named volume rather than the image's own filesystem so that
 * wp-cli — a separate container — can see it too.
 *
 * Everything from the repo is mounted *into* that volume, never over it. A bind
 * mount at wp-content would make Docker create mountpoints inside the real repo
 * directory, which writes stray files into it and fails outright for single
 * files.
 *
 * @param {Object} site Resolved site.
 * @return {string[]} Compose volume entries.
 */
function siteVolumes( site ) {
	const volumes = [ `${ coreVolume( site ) }:/var/www/html` ];

	for ( const muPlugin of site.muPlugins ) {
		volumes.push(
			`${ muPlugin.source }:/var/www/html/wp-content/mu-plugins/${ muPlugin.name }`
		);
	}

	for ( const theme of site.themes ) {
		volumes.push( `${ theme.source }:/var/www/html/wp-content/themes/${ theme.name }` );
	}

	// Local plugins are the repo's own code, so mount them to stay editable.
	// Everything else is installed by wp-cli.
	for ( const plugin of site.plugins.filter( ( p ) => p.type === 'mount' ) ) {
		volumes.push( `${ plugin.source }:/var/www/html/wp-content/plugins/${ plugin.name }` );
	}

	// Uploads bind to the repo so media is visible on the host. Every client
	// repo already gitignores /uploads/.
	volumes.push( `${ path.join( site.root, 'uploads' ) }:/var/www/html/wp-content/uploads` );

	// Declared last so a repo can mount something the defaults above don't
	// cover, without being able to shadow the mounts the site is built from.
	for ( const mount of site.mounts ?? [] ) {
		volumes.push( `${ mount.source }:/var/www/html/wp-content/${ mount.target }` );
	}

	return volumes;
}

/**
 * Build the Apache config that proxies missing uploads to a production origin.
 *
 * This is the analog of a Valet driver's missing-file fallback. Under Valet
 * every request runs through PHP, so a driver can catch a missing upload and
 * redirect it. Here Apache serves uploads straight off the bind mount and a
 * missing file never reaches PHP — so the fallback has to live in Apache, as a
 * rewrite that checks the filesystem and, on a miss, reverse-proxies upstream.
 *
 * Three things the official image doesn't do by default have to be arranged:
 *
 *   - mod_proxy and mod_proxy_http aren't loaded (only mod_rewrite is, for
 *     permalinks). They're loaded here by path, guarded so a future image that
 *     ships them enabled doesn't double-load.
 *   - Proxying to an https origin needs the SSL proxy engine, hence mod_ssl and
 *     `SSLProxyEngine On`. Both are harmless when the origin is plain http.
 *   - A rewrite in the main server config is not inherited by the image's
 *     vhost, so it would never run. `RewriteOptions InheritDown` pushes it down
 *     into the vhost where the request is actually served.
 *
 * The rule only fires for `/wp-content/uploads/` and only when the file is
 * absent locally, so present media is served from disk and everything outside
 * uploads is untouched. `ProxyPassReverse` rewrites any redirect the origin
 * sends back so it stays on the dev host.
 *
 * @param {Object} site Resolved site.
 * @return {string} Apache config source.
 */
function uploadsFallbackConf( site ) {
	const origin = site.uploadsFallback;

	return (
		`# Managed by @happyprime/env.\n` +
		`# Serve uploads missing locally from ${ origin }.\n` +
		`\n` +
		`<IfModule !proxy_module>\n` +
		`\tLoadModule proxy_module /usr/lib/apache2/modules/mod_proxy.so\n` +
		`</IfModule>\n` +
		`<IfModule !proxy_http_module>\n` +
		`\tLoadModule proxy_http_module /usr/lib/apache2/modules/mod_proxy_http.so\n` +
		`</IfModule>\n` +
		`<IfModule !ssl_module>\n` +
		`\tLoadModule ssl_module /usr/lib/apache2/modules/mod_ssl.so\n` +
		`</IfModule>\n` +
		`\n` +
		`SSLProxyEngine On\n` +
		`\n` +
		`RewriteEngine On\n` +
		`RewriteOptions InheritDown\n` +
		`RewriteCond %{REQUEST_URI} ^/wp-content/uploads/\n` +
		`RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f\n` +
		`RewriteRule ^/wp-content/uploads/(.+)$ ${ origin }/wp-content/uploads/$1 [P,L]\n` +
		`\n` +
		`ProxyPassReverse /wp-content/uploads/ ${ origin }/wp-content/uploads/\n`
	);
}

/**
 * Escape a value against docker compose's variable interpolation.
 *
 * Compose expands `$NAME` when it reads the file, so PHP like `$_SERVER` would
 * silently become an empty string and leave wp-config.php syntactically broken.
 * `$$` is compose's literal dollar sign.
 *
 * @param {string} value Raw value.
 * @return {string} Value safe to embed in a compose file.
 */
function escapeForCompose( value ) {
	return String( value ).replace( /\$/g, '$$$$' );
}

/**
 * Environment shared by the site's WordPress and wp-cli containers.
 *
 * @param {Object} site Resolved site.
 * @return {Object} Environment variables.
 */
function siteEnv( site ) {
	const env = {
		WORDPRESS_DB_HOST: MYSQL_HOST,
		WORDPRESS_DB_USER: MYSQL_USER,
		WORDPRESS_DB_PASSWORD: MYSQL_PASSWORD,
		WORDPRESS_DB_NAME: site.slug,
		WORDPRESS_CONFIG_EXTRA: configExtra( site ),
	};

	return Object.fromEntries(
		Object.entries( env ).map( ( [ key, value ] ) => [ key, escapeForCompose( value ) ] )
	);
}

/**
 * Render a site's compose file and write it to the state directory.
 *
 * @param {Object} site Resolved site.
 * @return {string} Path to the written compose file.
 */
export function writeCompose( site ) {
	const dir = siteDir( site.slug );
	fs.mkdirSync( dir, { recursive: true } );

	const volumes = siteVolumes( site );
	const environment = siteEnv( site );

	// The uploads fallback is Apache config, so it belongs only to the web
	// container — the wp-cli image runs no Apache. Written into the state dir
	// beside the compose file and mounted read-only.
	const wordpressVolumes = [ ...volumes ];
	if ( site.uploadsFallback ) {
		const confPath = path.join( dir, 'uploads-fallback.conf' );
		fs.writeFileSync( confPath, uploadsFallbackConf( site ) );
		wordpressVolumes.push(
			`${ confPath }:/etc/apache2/conf-enabled/uploads-fallback.conf:ro`
		);
	}

	const compose = {
		name: `hp-site-${ site.slug }`,
		services: {
			wordpress: {
				// Core is baked into the image, so there is nothing to download
				// and a cold boot is seconds.
				image: `wordpress:${ site.wordpress }-php${ site.php }-apache`,
				container_name: `hp-site-${ site.slug }`,
				restart: 'unless-stopped',
				networks: [ NETWORK ],
				environment,
				volumes: wordpressVolumes,
				labels: [
					'traefik.enable=true',
					`traefik.docker.network=${ NETWORK }`,
					`traefik.http.routers.${ site.slug }.rule=Host(\`${ site.host }\`)`,
					`traefik.http.routers.${ site.slug }.entrypoints=websecure`,
					`traefik.http.routers.${ site.slug }.tls=true`,
					`traefik.http.services.${ site.slug }.loadbalancer.server.port=80`,
				],
			},
			cli: {
				image: `wordpress:cli-php${ site.php }`,
				// Only runs via `docker compose run`, never on `up`.
				profiles: [ 'cli' ],
				networks: [ NETWORK ],
				environment,
				volumes,
				user: '33:33',
			},
		},
		volumes: {
			[ coreVolume( site ) ]: {},
		},
		networks: {
			[ NETWORK ]: { external: true },
		},
	};

	const file = path.join( dir, 'docker-compose.yml' );
	fs.writeFileSync( file, JSON.stringify( compose, null, 2 ) + '\n' );

	return file;
}
