<?php
/**
 * Plugin Name: Mail catcher
 * Description: Sends every message this site produces to the shared Mailpit container rather than out to the internet.
 *
 * Mounted into every site by @happyprime/env. This can't live in wp-config the
 * way the rest of the environment's configuration does, because the filter it
 * needs is added before WordPress has any filters to add it to.
 */

/**
 * Points PHPMailer at Mailpit's SMTP listener.
 *
 * Hooked last so that a site which configures its own SMTP transport still has
 * its mail caught here rather than delivered from a development machine.
 *
 * @param PHPMailer\PHPMailer\PHPMailer $phpmailer Mailer about to send.
 */
add_action(
	'phpmailer_init',
	function ( $phpmailer ) {
		$phpmailer->isSMTP();
		$phpmailer->Host     = 'hp-mailpit';
		$phpmailer->Port     = 1025;
		$phpmailer->SMTPAuth = false;

		// Opportunistic TLS has nothing to protect on a container network, and
		// Mailpit's certificate is not one this container would trust anyway.
		$phpmailer->SMTPAutoTLS = false;
		$phpmailer->SMTPSecure  = '';
	},
	PHP_INT_MAX
);
