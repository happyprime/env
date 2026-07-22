/**
 * The local development certificate.
 *
 * One certificate serves every project on the machine. Its names are derived
 * from the hosts projects declare, so adding a project only regenerates when it
 * brings a domain the certificate doesn't already cover.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { capture } from './docker.mjs';
import { CERT_DIR } from './compose.mjs';

export const CERT_FILE = path.join( CERT_DIR, 'local.pem' );
export const KEY_FILE = path.join( CERT_DIR, 'local-key.pem' );

// What the current certificate covers. Hosts are per-project but the
// certificate is per-machine, so the names it carries can't be recomputed from
// any one project — they have to be remembered.
const COVERAGE_FILE = path.join( CERT_DIR, 'coverage.json' );

/**
 * The certificate name that covers a host.
 *
 * A wildcard is used where one is valid, so sibling projects on the same domain
 * need no certificate work at all. Where one isn't, the host is named outright.
 *
 * Hostname verification refuses a wildcard that spans a registry-controlled
 * domain: `*.dev` and `*.com` are rejected, and so is any unknown TLD, which is
 * why the `*.test` scheme this replaced could never work. `*.example.dev` is
 * fine — the wildcard sits below the registry rather than over it.
 *
 * Approximated by label count, which is what the rule works out to for every
 * TLD anyone develops against, and is the same heuristic mkcert itself uses.
 * It is wrong only for a multi-label suffix like `co.uk`, where a host of
 * `site.co.uk` would derive an invalid `*.co.uk`. Nobody has hit that; if
 * somebody does, this wants the public suffix list rather than a bigger guess.
 *
 * @param {string} host Hostname.
 * @return {string} A wildcard covering the host, or the host itself.
 */
export function nameFor( host ) {
	// Hostnames are case-insensitive and may carry a trailing root dot, but the
	// names on a certificate are compared as text — so `Example.dev` and
	// `example.dev.` would each earn a redundant second name covering exactly
	// what the first already does.
	const labels = host.trim().toLowerCase().replace( /\.$/, '' ).split( '.' );

	// Two labels after the `*` is the shallowest a wildcard may sit.
	return labels.length >= 3 ? `*.${ labels.slice( 1 ).join( '.' ) }` : labels.join( '.' );
}

/**
 * The certificate names covering a set of hosts.
 *
 * Derived per host and then deduplicated, rather than from one domain shared by
 * all of them. Hosts nested a level deeper (`www.foo.example.dev`) get their own
 * wildcard that way, since a wildcard only ever matches one label.
 *
 * @param {string[]} hosts Hostnames.
 * @return {string[]} Certificate names.
 */
export function namesFor( hosts ) {
	return [ ...new Set( hosts.map( nameFor ) ) ].sort();
}

/**
 * Identify the CA that would sign a certificate generated now.
 *
 * A fingerprint of the root itself rather than of where it lives: `mkcert
 * -install` against an emptied CAROOT mints a brand new root at the same path,
 * which leaves every certificate the old one signed untrusted while every path
 * still matches. Hashing the contents is what notices.
 *
 * Doubles as the check that mkcert is installed and set up at all, since
 * neither question can be answered without reading exactly this file.
 *
 * @return {string} Fingerprint of mkcert's root CA.
 */
function caFingerprint() {
	const { code, stdout } = capture( 'mkcert', [ '-CAROOT' ] );

	if ( code !== 0 ) {
		throw new Error(
			'mkcert not found. Install it first: https://github.com/FiloSottile/mkcert#installation'
		);
	}

	const root = path.join( stdout.trim(), 'rootCA.pem' );

	// A certificate is only useful if the root CA that signed it is trusted, and
	// installing that touches the system trust store — which needs a password, so
	// it can't be done for you from here.
	if ( ! fs.existsSync( root ) ) {
		throw new Error(
			"mkcert's root CA isn't set up yet, so nothing would trust the certificate.\n" +
				'Create and trust it with:  mkcert -install'
		);
	}

	return createHash( 'sha256' ).update( fs.readFileSync( root ) ).digest( 'hex' );
}

/**
 * Whether the certificate and its key are both on disk.
 *
 * @return {boolean} True when present.
 */
export function certExists() {
	return fs.existsSync( CERT_FILE ) && fs.existsSync( KEY_FILE );
}

/**
 * The record of what the certificate covers.
 *
 * Read independently of whether the certificate itself is still there. A
 * deleted pem is a certificate to reissue, not a reason to forget which names
 * other projects are relying on — dropping those would quietly narrow the next
 * certificate to whichever project happened to run first.
 *
 * @return {Object|null} Coverage, or null when there's no readable record.
 */
function readCoverage() {
	try {
		return JSON.parse( fs.readFileSync( COVERAGE_FILE, 'utf8' ) );
	} catch {
		return null;
	}
}

/**
 * Generate the certificate with mkcert.
 *
 * @param {Object}   options       Options.
 * @param {string[]} options.names Certificate names.
 * @param {Function} options.log   Logger.
 * @return {string} Path to the certificate.
 */
export function generateCert( { names, log = console.log } = {} ) {
	if ( ! names?.length ) {
		throw new Error( 'A certificate needs at least one name.' );
	}

	const ca = caFingerprint();

	fs.mkdirSync( CERT_DIR, { recursive: true } );

	const { code, stderr } = capture( 'mkcert', [
		'-cert-file',
		CERT_FILE,
		'-key-file',
		KEY_FILE,
		...names,
	] );

	if ( code !== 0 ) {
		throw new Error( `mkcert failed: ${ stderr }` );
	}

	// Written only once mkcert has succeeded, so a failed run leaves the old
	// record describing the old certificate — both stale together, rather than a
	// record claiming names that were never issued.
	fs.writeFileSync( COVERAGE_FILE, JSON.stringify( { names, ca }, null, 2 ) + '\n' );

	log( `Certificate generated for ${ names.join( ', ' ) }` );
	log( `  ${ CERT_FILE }` );

	return CERT_FILE;
}

/**
 * Regenerate the certificate deliberately.
 *
 * `ensureCert` only acts when something is missing, which is right for `start`
 * but leaves no way to reissue on demand — after trusting a new CA root, say.
 *
 * @param {Object}   options       Options.
 * @param {string[]} options.hosts Hosts that must be covered.
 * @param {boolean}  options.only  Drop names no longer in use.
 * @param {Function} options.log   Logger.
 */
export function regenerateCert( { hosts = [], only = false, log = console.log } = {} ) {
	const required = namesFor( hosts );
	const existing = only ? [] : readCoverage()?.names ?? [];
	const names = [ ...new Set( [ ...existing, ...required ] ) ].sort();

	if ( ! names.length ) {
		throw new Error(
			'Nothing to put on a certificate: no project here to take hosts from, and no\n' +
				'existing certificate to reissue. Run this from a project with a\n' +
				'.happy-env.json — its hosts are what a certificate covers.'
		);
	}

	generateCert( { names, log } );
}

/**
 * Generate the certificate if it doesn't already cover these hosts.
 *
 * Names accumulate: a machine that has run projects on two domains needs one
 * certificate carrying both, and dropping a domain the moment another project
 * stops using it would mean regenerating every time you switched projects. A
 * stale name costs nothing — `cert --only` is the way to start over.
 *
 * @param {Object}   options       Options.
 * @param {string[]} options.hosts Hosts that must be covered.
 * @param {Function} options.log   Logger.
 * @return {boolean} True when a new certificate was generated.
 */
export function ensureCert( { hosts, log = console.log } ) {
	const required = namesFor( hosts );
	const coverage = readCoverage();

	// Union the derived names, never re-derive them: `nameFor` applied to
	// `*.foo.example.dev` would hand back `*.example.dev` and quietly widen what
	// the certificate claims.
	const names = [ ...new Set( [ ...( coverage?.names ?? [] ), ...required ] ) ].sort();

	if ( ! certExists() ) {
		log( 'Generating a certificate…' );
	} else if ( ! coverage ) {
		// A certificate with no readable record of what it covers can't be
		// reasoned about, and is worth no more than none at all.
		log( "Can't tell what the certificate covers — reissuing it…" );
	} else {
		const covered = new Set( coverage.names );
		const missing = required.filter( ( name ) => ! covered.has( name ) );

		if ( ! missing.length ) {
			if ( coverage.ca === caFingerprint() ) {
				return false;
			}

			// The certificate is still on disk and still covers the right names,
			// but the CA that signed it is gone, so nothing believes it any more.
			log( "mkcert's root CA has changed — reissuing the certificate…" );
		} else {
			log( `Certificate doesn't cover ${ missing.join( ', ' ) } — reissuing it…` );
		}
	}

	generateCert( { names, log } );

	return true;
}
