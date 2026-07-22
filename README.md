# happy-env

Shared local development for WordPress projects. A project opts in with one
small file and gets a trusted-HTTPS site — no per-project proxy, certificate,
database, port, or `/etc/hosts` work.

```
*.example.dev  ──►  127.0.0.2  ──►  Traefik  ──►  your site container
                                                  │
                                    one MariaDB ──┘  (one database per site)
```

Every project shares one proxy, one database server, and one certificate.
Adding a project costs a config file and a schema — not another MySQL container,
another core download, and another port to keep out of everything else's way.

This suits *sites*. Plugin and theme repos are usually better served by wp-env,
which does multi-version testing and PHPUnit scaffolding that this deliberately
doesn't.

## Requirements

- **Docker.** Docker Desktop, OrbStack, or Colima.
- **[mkcert](https://github.com/FiloSottile/mkcert#installation)**, with its root
  CA trusted (`mkcert -install`). That touches your system trust store and needs
  a password, so it can't be done for you.
- **Node 20+**.
- **macOS or Linux.** Windows/WSL2 isn't supported: Docker Desktop publishes
  ports on the Windows side, where binding a loopback alias isn't dependable.

## Pick how hosts resolve

This is the one decision to make up front, and the only part that isn't
automatic. Your site's hostname has to resolve to the proxy. There are three
ways, and they trade off setup against convenience.

### A domain you control (what we do)

Point a wildcard `A` record at the loopback alias:

```
*.example.dev.  A  127.0.0.2
```

Every project on that domain then works with no further DNS work, ever. The
certificate is a wildcard, so adding a project needs no certificate work either.

The tradeoffs: you need a domain, and resolving a public record needs a network
connection — nothing resolves on a plane (see [Working offline](#working-offline)).
Use a domain you don't also serve from, or a subdomain of one — `*.dev.example.com`
works fine and leaves `example.com` alone.

### `.localhost` (nothing to set up)

`*.localhost` resolves to `127.0.0.1` on macOS and on systemd Linux with no DNS
record, no network, and no `/etc/hosts` line. Set a host like
`mysite.dev.localhost` and it just works.

This needs the proxy on `127.0.0.1` rather than the default alias:

```json
{ "bindAddress": "127.0.0.1" }
```

in `~/.happy-env/config.json`. The cost is that the proxy then contends for port
80 with everything else on your machine, which the alias exists to avoid.

Use three labels (`mysite.dev.localhost`, not `mysite.localhost`) if you want a
wildcard certificate covering siblings — see [Certificates](#certificates).

### `/etc/hosts`

Universal, offline, needs no domain, and is manual for every host:

```
127.0.0.2 mysite.example.dev
```

## Quick start

```sh
npm install --save-dev @happyprime/env
```

```json
{
	"scripts": {
		"env:start": "happy-env start",
		"env:stop": "happy-env stop",
		"env:cli": "happy-env cli"
	}
}
```

On macOS, unless you chose `127.0.0.1` above, persist the loopback alias the
proxy binds — once per machine:

```sh
sudo cp node_modules/@happyprime/env/com.happyprime.loopback-alias.plist /Library/LaunchDaemons/
sudo launchctl load -w /Library/LaunchDaemons/com.happyprime.loopback-alias.plist
```

Linux needs nothing here: the whole `127.0.0.0/8` routes to loopback already.

Then, in any project:

```sh
npm run env:start
```

The first run generates the certificate and starts the shared services, so
there's no separate setup step. `start` brings up the proxy and MariaDB if they
aren't already running, creates the site's database, boots it, and installs
WordPress on first run.

## Configuring a project

A repo *is* a `wp-content` directory, so almost everything is read off disk. Most
projects need one line:

```json
{
	"host": "mysite.example.dev"
}
```

Themes, plugins, and mu-plugins are discovered from `./themes`, `./plugins`, and
`./mu-plugins`. Symlinks are resolved to their real paths, so shared code linked
out to a sibling repo is mounted where it actually lives — a symlink to an
absolute host path means nothing inside a container.

### Several sites in one repo

Use `sites` instead of `host`. Each site gets its own container and database; the
key names both. `root` points at a site's `wp-content` when it isn't the repo
root:

```json
{
	"php": "8.3",
	"wordpress": "6.9.4",
	"config": { "WP_MEMORY_LIMIT": "512M" },
	"sites": {
		"blog": {
			"host": "blog.example.dev",
			"root": "./blog/wp-content"
		},
		"shop": {
			"host": "shop.example.dev",
			"root": "./shop/wp-content"
		}
	}
}
```

### Every key

| Key         | Default             | Notes                                                        |
| ----------- | ------------------- | ------------------------------------------------------------ |
| `host`      | —                   | Single-site shorthand. Mutually exclusive with `sites`.       |
| `sites`     | —                   | Several sites, keyed by slug. The slug names the database.    |
| `php`       | `8.4`               | `8.5` works. `8.6` isn't released.                            |
| `wordpress` | `6.9`               | `6.9` resolves to its latest patch at creation; `6.9.4` pins. |
| `themes`    | every dir in `./themes`  | Default themes are skipped — core supplies them.         |
| `plugins`   | every dir in `./plugins` | See below.                                               |
| `muPlugins` | `./mu-plugins`      | Mounted entry by entry, not as one directory.                 |
| `mounts`    | `{}`                | Extra paths into `wp-content`, as `{ source: target }`.       |
| `config`    | `{}`                | Extra `wp-config.php` constants.                              |
| `root`      | repo root           | Per-site only.                                                |

**Declared vs. discovered plugins.** Listing `plugins` explicitly is an intent to
use them, so they're installed and activated. Anything merely *found* on disk is
mounted and left alone — whether it's active is the database's business, and
force-activating would silently override a site's real state. Declared entries
accept a wordpress.org slug (`woocommerce`), a pinned slug (`woocommerce@10.7.0`),
a zip URL, or a local path (`./plugins/thing`, mounted so it stays editable).

**Extra mounts.** `themes`, `plugins`, `mu-plugins`, and `uploads` cover most
repos. `mounts` is for what's left — in practice a composer `vendor` directory
sitting at the wp-content root, which plugins in the same repo autoload from
rather than from their own directory:

```json
{
	"host": "mysite.example.dev",
	"mounts": { "./vendor": "vendor" }
}
```

Sources are relative to the site root, targets to `wp-content`. A source that
doesn't exist is an error at start rather than a puzzle later — a missing
`vendor` says to run `composer install`.

A pin is applied when the plugin is first installed. Changing `@10.7.0` to
`@10.8.0` won't move a site that already has it — the plugin is present, so
there's nothing to install. `happy-env cli <site> plugin update` moves it, and
`reset` (or `destroy`) starts over.

## Machine settings

`~/.happy-env/config.json` holds the few things that are about your computer
rather than any project. It's optional, and most people never write one.

| Key             | Default           | Notes                                                     |
| --------------- | ----------------- | --------------------------------------------------------- |
| `bindAddress`   | `127.0.0.2`       | Where the proxy listens. `127.0.0.1` for `.localhost`.     |
| `dashboardHost` | `proxy.localhost` | Traefik's dashboard. Only reachable if it resolves to `bindAddress`. |

## Commands

| Command                  | Does                                                  |
| ------------------------ | ----------------------------------------------------- |
| `happy-env start [site…]`| Start the shared services and this repo's sites        |
| `happy-env stop [site…]` | Stop containers, keeping them (restart is seconds)     |
| `happy-env reset [site…]`| Drop the database and reinstall WordPress fresh (asks first; `--yes` skips) |
| `happy-env destroy [site…]` | Remove containers, volumes, and the database        |
| `happy-env status`       | What's running                                         |
| `happy-env cli <site> …` | Run wp-cli, e.g. `happy-env cli blog plugin list`      |
| `happy-env cert [--only]`| Reissue the certificate (`start` does this for you)    |
| `happy-env services stop`| Stop the shared proxy and MariaDB                      |

Admin credentials are `admin` / `password`.

## How it works

**Core comes from the image.** Sites run the official
`wordpress:<wp>-php<php>-apache` image, which already contains WordPress — so
choosing a version is a tag lookup and a cold boot is seconds. Nothing is
downloaded or unpacked per project.

That's also the whole version story: anything is fair game if the tag exists.
`"wordpress": "beta"` follows the next release's latest beta or RC, and
`"beta-6.8-RC1"` pins one exactly. A PHP version works the day its image is
published and not before. **WordPress nightly/trunk has no image at all**, so
testing against trunk still means wp-env, which builds core from git.

Core lives in a volume named for the WordPress version, so switching versions
picks up the right core. The image's entrypoint copies core in only when the
volume has none, and never looks at the version again either way — so a single
volume would go on serving whatever booted into it first, no matter what the tag
and the config now say. That's the worst way to fail when the reason you pinned
a version was to test against it. Databases and uploads live outside that
volume, so switching back and forth costs nothing.

The volume is keyed on the version *as you wrote it*, which has one consequence
worth knowing: `"wordpress": "6.9"` is a single volume even though the tag behind
it moves with every patch. A site created on 6.9.4 stays on 6.9.4 — `destroy` and
start again is what picks up 6.9.5. Pin fully (`"6.9.4"`) if you want the version
to be unambiguous on sight.

**One MariaDB.** Every site is a schema on the shared server, not a container of
its own. Adding a site costs a database, and a test database costs the same.
It's published on `127.0.0.1:3307` for host tools, since a Homebrew MariaDB
usually holds 3306. Sites reach it as `hp-mysql` over the network.

**Routing is by label, not port.** Site containers join the `hp-env` network and
Traefik routes on the Host header, so nothing publishes a host port. There are no
ports to allocate and none to collide — which is worth stating plainly, because
port collisions are the most common way an e2e suite fails, silently running
against whatever WordPress answered instead.

**Site config is eval'd, not written.** The official image's `wp-config.php` runs
`if ($configExtra = getenv_docker('WORDPRESS_CONFIG_EXTRA', '')) {
eval($configExtra); }` just before it requires `wp-settings.php`, so `WP_HOME`,
`WP_SITEURL`, and anything in `config` are applied as part of wp-config — and
because core hasn't loaded yet, early enough that it derives `WP_CONTENT_URL`
and `WP_PLUGIN_URL` from the right URL. No mu-plugin is involved. The image also
sets `$_SERVER['HTTPS']` from `X-Forwarded-Proto` on its own, so terminating TLS
at Traefik needs no handling at all.

## Certificates

One certificate serves every project on the machine. It lives in
`~/.happy-env/certs` rather than in the package: npm may replace `node_modules`
wholesale on any reinstall, and a copy per project would be worse than useless.

Its names are derived from the hosts your projects declare — each host's own
parent, deduplicated — and recorded in `~/.happy-env/certs/coverage.json`.
`start` reissues only when a project brings a name that isn't covered yet, and
restarts the proxy when it does, since Traefik reads the certificate once at
startup.

Names accumulate across projects. A machine running one project on
`*.example.dev` and another on `*.other.dev` has one certificate carrying both;
dropping a name the moment a project stopped using it would mean reissuing every
time you switched projects. A stale name costs nothing. `happy-env cert --only`
reissues from just the current project when you want it gone.

**Where a wildcard is used, and where it isn't.** Hostname verification refuses a
wildcard that spans a registry-controlled domain: `*.dev` and `*.com` are
rejected, and an unknown TLD counts as a registry too — which is why the `*.test`
scheme this replaced could never work. So:

| Host                    | Certificate name    |
| ----------------------- | ------------------- |
| `mysite.example.dev`    | `*.example.dev`     |
| `www.foo.example.dev`   | `*.foo.example.dev` |
| `mysite.dev.localhost`  | `*.dev.localhost`   |
| `mysite.localhost`      | `mysite.localhost`  |
| `example.dev`           | `example.dev`       |

The last two get no wildcard — the name above them is a registry — so each such
host is named outright and a sibling means reissuing. That's the reason to prefer
three labels.

Wildcards are also only one label deep: `*.example.dev` does not cover
`www.foo.example.dev`. Deriving each host's own parent is what handles that, so
nesting needs no thought.

## Sharing ports

**Only one proxy can hold `:80`/`:443` at a time under OrbStack.** `start` checks
first and names whatever is holding the ports, rather than letting Docker report
an address and leave you guessing.

This is worth explaining, because the obvious fix doesn't work. Traefik binds a
loopback alias precisely so it could sit beside something on `127.0.0.1`. Under
Docker that does work. **Under OrbStack it doesn't:** ports are allocated by
number and routed to a single container regardless of which host IP the binding
names. Two proxies on `127.0.0.1` and `127.0.0.2` both start happily, and then
one of them silently answers for both addresses — verified by watching one
stack's proxy serve another's certificate while its own sat there healthy and
unreachable. Picking a third loopback address changes nothing.

It doesn't help that some stacks publish `'80:80'` with no host IP at all, which
is every interface — so they conflict with anything on those ports no matter
what.

**It doesn't have to be a container.** Laravel Valet, a Homebrew nginx, an Apache
left running from something else — anything holding `:80`/`:443` on the host does
this too, and that case is the more confusing one, because nothing reports it.
`compose up` succeeds, Traefik starts and logs nothing wrong, and the published
port simply never listens: every site is unreachable while the proxy looks
perfectly healthy. `start` checks for these too and names the process. For Valet,
`valet stop` frees the ports.

So, under OrbStack: mutual exclusion, until either it honours host IPs or one
proxy fronts both stacks.

## Working offline

Public DNS needs a network, so nothing resolves on a plane. Add the hosts you
need to `/etc/hosts`:

```
127.0.0.2 mysite.example.dev blog.example.dev
```

That's deliberately manual. A local dnsmasq answering `*.example.dev` would be
automatic, but it would also hijack the real `example.dev` and `www` on your own
machine — it can't wildcard a domain you actually use without shadowing it. It
would also bind `:53`, which is its own conflict to manage.

`.localhost` hosts resolve offline with no help at all, which is a reason to
prefer them if you fly a lot.

## Gotchas worth knowing

- **Compose interpolates `$`.** Anything with a dollar sign in a compose file —
  PHP like `$_SERVER`, most obviously — is expanded as a variable and silently
  becomes an empty string, leaving `wp-config.php` syntactically broken and
  taking wp-cli down with it. Values are escaped (`$$`) on the way out; see
  `escapeForCompose()`.
- **`WORDPRESS_CONFIG_EXTRA` is eval'd**, so it must be bare PHP with no opening
  tag, and a syntax error breaks the site *and* wp-cli.
- **Never mount a directory at `wp-content`.** It becomes the parent of every
  other mount, so Docker creates mountpoints *inside* the real repo — writing
  stray files into it, and failing outright for single files. Mount pieces into
  the container's own `wp-content` instead.
- **Every wp-cli call is a container** that loads WordPress, which is seconds on
  a large site. Batch them. An already-installed site should make one call and
  stop.
- **Changing `php` or `wordpress` changes the image tag**, but core lives in a
  volume that survives. `happy-env destroy <site>` and start again if a version
  change doesn't take.

## Not solved yet

**Content.** A repo is `wp-content`, so there's no database in git and
`happy-env start` gives you an empty WordPress. That's fine for theme work and
not fine for much else. Seeding — a sanitized dump plus something like
media-from-production for uploads — is the obvious next piece, and lifecycle
hooks (`afterInstall`) are the shape it probably wants.

**Extra services.** Redis, Elasticsearch, and a mail catcher have nowhere to go
today. A `services` key merged into the generated compose file is the natural
hook; nothing in the current structure fights it.

**xdebug.** The official image doesn't ship it, so this needs a derived image.

## Working on this package

A project pins a version, so editing `environment` doesn't change what that repo
runs until the version is bumped and reinstalled. That's the point — a
teammate's `npm ci` gets byte-identical tooling — but it makes for a slow loop
when you're changing the CLI itself. Either run the working copy directly:

```sh
node ../../environment/bin/happy-env.mjs start
```

or `npm link` it into the project you're testing against.

To release: bump `version`, commit, tag `vX.Y.Z`, push the tag, `npm publish`,
then bump the dependency in each consuming repo.
