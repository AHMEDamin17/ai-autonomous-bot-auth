# Orchestrator Modes: Deterministic vs. Agent

`ANALYTICS_ORCHESTRATOR_MODE` selects **who decides the order** in which the analytics tools run. Both modes require the configured LLM as the semantic entry and retain the same backend-owned guards, validation, compiler, and response assembly.

Values: `deterministic` (default) | `agent`.

Any other value is rejected with a configuration error so a misspelled mode cannot
silently change how the request is orchestrated.

---

## The key difference: who decides the next tool

**Important fact:** in both modes, the tool chain runs `query_classifier_tool` → `pre_query_guard_tool` → `planner_tool` → `validator_tool` → `sql_compiler_tool` → `db_execute_tool` → `result_quality_tool` → `insight_builder_tool`. Only `planner_tool` uses the LLM for semantic planning:

- **classifier** — heuristic token scoring (no LLM)
- **guard** — regex / date checks (no LLM)
- **planner** — the LLM call
- **validator, compiler, execute, result_quality, insight_builder** — all deterministic code

### Deterministic loop (default)

A plain `while` loop starts with `query_classifier_tool`, then `pre_query_guard_tool`, then `planner_tool` — each of the first two is pure backend code (no LLM), and each still gets its own entry in the execution trace. `planner_tool` is where the model interprets the question and returns a structured plan; backend code then follows each tool's `next` pointer the rest of the way.

So a clean request = **1 LLM call total** (the planner), maybe 2–3 if the planner has to re-plan after validation/compiler feedback.

### Agent (ReAct)

The agent **is itself an LLM**. To advance the workflow it "thinks" and emits a tool call, then reads the result, then thinks again for the next tool. So **each step in the chain is its own LLM call**.

| Step | Deterministic loop | ReAct agent |
|---|---|---|
| interpret and plan the question | **LLM call** | **LLM tool-selection call(s) + planner LLM call** |
| apply read-only/date guards | code | **LLM selects backend guard tool** |
| pick validator | code | **LLM call** |
| pick compiler | code | **LLM call** |
| pick execute | code | **LLM call** |
| pick quality | code | **LLM call** |
| pick insight | code | **LLM call** |
| **≈ total LLM calls** | **~1–2** | **~8–10** |

That **~5–8× multiplier** is what "the deterministic loop uses less" means. It's why free-tier quotas drain much faster in `agent` mode.

---

## Does it always follow that order?

This is the crucial nuance, and the honest answer is: **not guaranteed the same way**.

**Deterministic loop** — the order is **guaranteed by code**:

```
classifier → guard → LLM planner → validator → compiler → execute → quality → insight
```

with hard branches back to the planner on retry. It cannot deviate.

**Agent** — the order is **guided and guarded, not guaranteed**. Three things keep it on the rails:

1. The system prompt tells the agent the required sequence.
2. Each tool returns a `next` recommendation.
3. **Most importantly — each tool enforces its own prerequisites.** If the agent tries to call `validator_tool` before a plan exists, or `db_execute_tool` before compilation, the tool refuses and returns "call planner/compiler first." So a bad ordering gets **rejected and corrected** rather than executing unsafely.

So "the agent drove all 8 tools in order" is an **observation of those runs** — a capable model followed the sequence cleanly. But the LLM makes the choice each turn, so:

- A weaker / less-reliable model can fumble the order → the prerequisite guards catch it and redirect it (costing extra tool calls / LLM calls), bounded by `ANALYTICS_ORCHESTRATOR_MAX_TOOL_CALLS` and `ANALYTICS_ORCHESTRATOR_RECURSION_LIMIT`.
- In a bad case it could stall or finish incomplete — which is exactly why the deterministic loop is the reliable default.

---

## Bottom line

Same tools, same intended order.

- The **deterministic loop guarantees** that order with **~1 LLM call**.
- The **agent chooses** it each step (**~8 LLM calls**), and the tool-level guards prevent it from ever doing something unsafe — but the ordering itself now depends on the model rather than being hard-coded.

That's the trade-off: **more autonomy and more provider usage** in `agent` mode, in exchange for the **deterministic guarantee** (and much lower quota use) in `deterministic` mode.

---

## How to switch

In `backend/.env`:

```env
# deterministic (default, recommended) | agent
ANALYTICS_ORCHESTRATOR_MODE=deterministic
```

`.env` changes require a backend restart (`nodemon` watches `src/**/*.ts`, not `.env`). Both modes reuse the single provider/model configured via `LLM_PROVIDER`.
