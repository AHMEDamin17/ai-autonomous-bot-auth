# Circuit Breaker Open

## Symptom
`/api/analytics/query` returns 503 with `circuitState: "open"` and a `retryAfterMs` header.

## Diagnosis
1. Open Observability tab → find connection marked OPEN in red.
2. Click into the connection's circuit-breaker endpoint: `GET /api/observability/circuit/{connectionId}`.
3. Inspect `failures`, `openedAt`, `cooldownMs`.

## Common causes
- DB credentials rotated
- DB host unreachable (network, DNS)
- DB rejecting connections due to max_connections

## Mitigation
1. Verify network: `curl https://<db-host>:<port>`.
2. Verify credentials: try `mysql -h ... -u ...` from the backend host.
3. If the DB recovered but the breaker hasn't closed, wait for `cooldownMs` (default 15s).
4. To manually close: `redis-cli HSET cb:conn-{id} status closed failures 0`.

## Escalation
If persists > 5 min, page on-call DBA.
