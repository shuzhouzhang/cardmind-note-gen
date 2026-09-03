# Agent Eval fixtures

`reliability-v1.json` drives deterministic, offline Runtime evaluation. Its model turns are scripted and every tool is an in-memory double. The suite cannot import application tool adapters, invoke Tauri, open SQLite, or read real notes. A model turn, approval, or sandbox response that is not declared by the fixture fails closed.

`live-smoke-v1.json` reuses the same sandbox catalog while replacing only the model port. Live mode is opt-in and has four gates: `--mode live`, `--provider notegen-free`, `--allow-network`, and `CARDMIND_AGENT_EVAL_LIVE=1`. Credentials are accepted only through the two explicit eval environment variables and are never written to fixtures or reports.

Both fixture schemas use `schemaVersion: 1`, require exactly ten unique scenarios, reject unknown structural fields, and forbid absolute or parent-traversal input paths. The live function-calling probe has no side effect and counts toward the global 30-call budget.
