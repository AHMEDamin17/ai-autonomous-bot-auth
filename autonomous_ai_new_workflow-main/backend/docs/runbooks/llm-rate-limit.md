# LLM Rate Limit

## Symptom
Analytics queries fail with LLM rate limit errors (429 Too Many Requests).

## Diagnosis
1. Check backend application logs for 429 status codes from the LLM provider.
2. Monitor usage limits in the provider dashboard.

## Common causes
- Spike in user traffic
- Quota exceeded

## Mitigation
1. Apply exponential backoff (already built in — see `LLM_RATE_LIMIT_*` env vars).
2. Request a quota increase from the provider.
3. Switch to a fallback LLM provider if configured: set `LLM_PROVIDER=openrouter`
   in `.env` and restart the backend (`.env` isn't nodemon-watched). Check
   `OPENROUTER_MODEL` is still a live free model first — the free lineup rotates —
   via `https://openrouter.ai/api/v1/models` and that model's `/endpoints` response.
4. Switch back to the primary provider once its window refills; don't leave a
   fallback provider active longer than needed — free-tier models have shown their
   own reliability issues (dropped constraints, unparseable structured output) in
   this project's testing, so they're a bridge, not a replacement.

## Notes from live incidents
- Groq's free-tier `GROQ_MIN_INTERVAL_MS` only paces *our own* outbound calls; it
  does not guarantee staying under Groq's actual account-level requests/tokens-per-
  minute caps. A burst of test/verification traffic can trip Groq's real 429 even
  with pacing in place — this isn't necessarily a sign of a code bug.
- A rate-limited call is not the same failure as a parsed-but-wrong plan (dropped
  filter, spurious ambiguity) — the latter is a model-reliability issue with the
  *configured model*, not a rate limit, and is not fixed by backoff or a provider
  switch alone. See `CompleteFixes.txt` §13, §19, §20 for documented cases of that
  distinct failure class.

## Escalation
Page the AI platform team.
