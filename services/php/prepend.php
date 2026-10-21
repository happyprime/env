<?php
/**
 * Environment prepend for sites that bring their own core
 *
 * Runs before every PHP script.
 * A site on the image's core gets all of this from the image's wp-config.php
 * and an mu-plugin mounted into wp-content. A checked-in core has its own
 * wp-config.php, and nothing can be mounted into its wp-content without Docker
 * writing a mountpoint into the repo — so @happyprime/env mounts this file and
 * a php.ini naming it as auto_prepend_file instead. Nothing here needs
 * WordPress to have loaded; it hasn't.
 */

// TLS ends at the proxy, so PHP sees plain HTTP. Without this WordPress treats
// every https request as insecure and redirects to itself forever.
if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && 'https' === $_SERVER['HTTP_X_FORWARDED_PROTO'] ) {
	$_SERVER['HTTPS'] = 'on';
}

// The `config` block of .happy-env.json, as guarded defines. Bare PHP, no
// opening tag, exactly as the image's wp-config.php would eval it.
$hp_env_config = getenv( 'WORDPRESS_CONFIG_EXTRA' );
if ( $hp_env_config ) {
	eval( $hp_env_config );
}
unset( $hp_env_config );

/**
 * Points PHPMailer at Mailpit's SMTP listener.
 *
 * Hooked last so that a site which configures its own SMTP transport still has
 * its mail caught rather than delivered from a development machine.
 *
 * @param PHPMailer\PHPMailer\PHPMailer $phpmailer Mailer about to send.
 */
function hp_env_mailpit( $phpmailer ) {
	$phpmailer->isSMTP();
	$phpmailer->Host     = 'hp-mailpit';
	$phpmailer->Port     = 1025;
	$phpmailer->SMTPAuth = false;

	// Opportunistic TLS has nothing to protect on a container network, and
	// Mailpit's certificate is not one this container would trust anyway.
	$phpmailer->SMTPAutoTLS = false;
	$phpmailer->SMTPSecure  = '';
}

// add_action() doesn't exist yet. wp-includes/plugin.php feeds whatever is
// already in $wp_filter through WP_Hook::build_preinitialized_hooks(), so a
// hook in this shape fires like any other.
$GLOBALS['wp_filter']['phpmailer_init'][ PHP_INT_MAX ]['hp_env_mailpit'] = array(
	'function'      => 'hp_env_mailpit',
	'accepted_args' => 1,
);
