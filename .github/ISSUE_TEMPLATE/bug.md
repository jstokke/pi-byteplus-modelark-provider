---
name: Bug report
about: Something is broken or behaving unexpectedly
---

## What happened

A clear description of the bug.

## Reproduction

Steps to reproduce, ideally with a minimal config:

```bash
pi
# then: /login byteplus, /model, and describe what you did
```

## Expected behavior

What you expected to happen instead.

## Environment

- Pi version (`pi --version`):
- Node version (`node --version`):
- OS:
- Signed in via `/login byteplus`, or using `BYTEPLUS_API_KEY` / `ARK_API_KEY`? (never paste the key itself)
- `BYTEPLUS_NO_ENRICHMENT` set?
- `~/.pi/agent/byteplus-coding-plan-cache.json` exists? (yes / no / not sure)
- `~/.pi/agent/byteplus-model-overrides.json` exists? (yes / no / not sure)

## Logs

Anything relevant from `pi` output — particularly any line starting with
`BytePlus ModelArk:`. The API key is never needed for diagnosis; please
redact it anyway.

## Model list

If models are missing or wrong, run `npm run smoke` in a checkout and paste
the summary — it reports what the live BytePlus docs currently advertise.
