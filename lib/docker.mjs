/**
 * Thin wrappers around the docker CLI.
 */

import { spawn, spawnSync } from 'node:child_process';

/**
 * Run a command, streaming its output to the terminal.
 *
 * @param {string}   command Command to run.
 * @param {string[]} args    Arguments.
 * @param {Object}   options Extra spawn options.
 * @return {Promise<number>} Exit code.
 */
export function run( command, args, options = {} ) {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( command, args, { stdio: 'inherit', ...options } );
		child.on( 'error', reject );
		child.on( 'close', ( code ) => resolve( code ?? 1 ) );
	} );
}

/**
 * Run a command and capture its output.
 *
 * @param {string}   command Command to run.
 * @param {string[]} args    Arguments.
 * @param {Object}   options Extra spawn options.
 * @return {Object} { code, stdout, stderr }
 */
export function capture( command, args, options = {} ) {
	const result = spawnSync( command, args, { encoding: 'utf8', ...options } );
	return {
		code: result.status ?? 1,
		stdout: ( result.stdout ?? '' ).trim(),
		stderr: ( result.stderr ?? '' ).trim(),
	};
}

/**
 * Whether a named container exists and is running.
 *
 * @param {string} name Container name.
 * @return {boolean} True when running.
 */
export function isRunning( name ) {
	const { stdout } = capture( 'docker', [
		'ps',
		'--filter',
		`name=^${ name }$`,
		'--format',
		'{{.Names}}',
	] );
	return stdout === name;
}

/**
 * Whether docker is reachable at all.
 *
 * @return {boolean} True when the daemon answers.
 */
export function dockerAvailable() {
	return capture( 'docker', [ 'info', '--format', '{{.ServerVersion}}' ] ).code === 0;
}

/**
 * Poll until a check passes or time runs out.
 *
 * @param {Function} check     Returns true when ready.
 * @param {Object}   options   Options.
 * @param {number}   options.timeout Milliseconds to wait.
 * @param {number}   options.interval Milliseconds between attempts.
 * @return {Promise<boolean>} True if the check passed.
 */
export async function waitFor( check, { timeout = 120000, interval = 1000 } = {} ) {
	const deadline = Date.now() + timeout;

	while ( Date.now() < deadline ) {
		if ( await check() ) {
			return true;
		}
		await new Promise( ( resolve ) => setTimeout( resolve, interval ) );
	}

	return false;
}
