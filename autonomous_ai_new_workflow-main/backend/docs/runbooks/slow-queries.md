# Slow Queries

## Symptom
High latency in analytical queries, queries timing out.

## Diagnosis
1. Check the observability dashboard for p95/p99 latency metrics.
2. Identify the specific queries causing the slowdown.

## Common causes
- Missing indexes
- Large data scans
- Database overload

## Mitigation
1. Add necessary indexes to the target database.
2. Optimize the generated SQL queries or adjust the catalog.

## Escalation
Page the performance engineering team.
