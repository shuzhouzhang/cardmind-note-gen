# CardMind Agent Replay Eval v1

- Status: PASS
- Suite: `reliability-v1`
- Mode/model: `replay` / `scripted-replay`
- Tested commit: `9d811f9061b0646975f186670c99adeb01fd44f7`
- Working tree: clean
- Generated: 2026-09-03T09:33:11.096Z
- Exit code: 0

## Metrics

- Scenario pass: 10/10 (100.0%)
- Guardrail assertions: 5/5 (100.0%)
- Unexpected real executions: 0
- Production tool manifest: 33 tools

## Scenarios

- PASS `direct-answer`: success / final_answer; requested []; executed []
- PASS `list-files`: success / final_answer; requested [note_list_files]; executed [note_list_files]
- PASS `schema-repair`: success / final_answer; requested [note_read_file, note_read_file]; executed [note_read_file]
- PASS `target-scope-repair`: success / final_answer; requested [note_read_file, note_read_file]; executed [note_read_file]
- PASS `selection-and-denial`: failed / approval_denied; requested [editor_replace_range, editor_replace_range]; executed []
- PASS `duplicate-write`: success / final_answer; requested [note_create_file, note_create_file]; executed [note_create_file]
- PASS `stream-retry`: success / final_answer; requested [note_list_files]; executed [note_list_files]
- PASS `tool-throw-structured`: success / final_answer; requested [note_read_file]; executed [note_read_file]
- PASS `partial-write`: partial / effect_unknown; requested [note_create_file, note_update_file]; executed [note_create_file, note_update_file]
- PASS `maximum-iterations`: failed / maximum_iterations; requested [nonexistent_tool, nonexistent_tool, nonexistent_tool]; executed []

## Failures

- None.

## Evidence boundaries

- Scripted model responses; this is not a measurement of model routing accuracy.
- Each scripted run is captured in memory and replayed with fresh deterministic runtime, sandbox, and approval state; equivalence is asserted without persisting message or chunk bodies.
- Every tool is an in-memory sandbox double; no Tauri command, production database, or real note is reachable.
- The sandbox exposes the same ordered 33-tool canonical manifest as production and replaces only executors.
- Idempotency assertions apply only within one AgentRuntime run, not across processes or runs.
