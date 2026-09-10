# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/jstokke/pi-byteplus-modelark-provider/security/advisories/new)
instead, or email the maintainer if that is unavailable to you.

Include what makes the report actionable: affected version, Pi version, steps
to reproduce, and the impact you believe it has. I'll acknowledge as soon as I
see it. This is a side project maintained by one person, so please be patient
rather than assuming it has been ignored.

## Scope

This extension is a Pi package, which means it runs with the same trust as any
other Pi package: extensions execute arbitrary code, so review the source
before installing — including this one.

The design decisions that matter here:

- **The extension never stores your API key.** `/login byteplus` hands the key
to Pi, which persists it in `~/.pi/agent/auth.json`. The extension reads it
back on demand through Pi's credential API, or from `BYTEPLUS_API_KEY` /
`ARK_API_KEY` in the environment.
- **The key is never logged.** Error and message paths are covered by the
secret-hygiene tests in `src/core.test.mjs` and `src/native-provider.test.mjs`.
A regression there is a security bug, not a cosmetic one.
- **Outbound requests are limited to BytePlus.** The extension calls the Coding
Plan endpoint and reads the public BytePlus documentation page used for model
discovery. `BYTEPLUS_PLAN_DOC_URL` can redirect the latter; if you set it, you
choose where that traffic goes.
- **No install scripts and no runtime dependencies.** The package has no
`preinstall`/`postinstall` hooks and ships no third-party code.

## Supported versions

The latest published version is the supported one. Fixes go into a new
release rather than a backport.
