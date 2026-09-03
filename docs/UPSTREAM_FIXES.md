# Selective upstream references

CardMind Agent Reliability v1 stays on the frozen NoteGen base
[`70e356981a360a59136043e97d7899007aa1022e`](https://github.com/codexu/note-gen/commit/70e356981a360a59136043e97d7899007aa1022e).
It does not merge the 221 later upstream commits. The six commits below were
reviewed individually; none was cherry-picked wholesale.

## Directly ported, narrow fixes

- [`b17a036c`](https://github.com/codexu/note-gen/commit/b17a036c): ensure every array parameter schema has an `items` definition. CardMind applies this to legacy schema adaptation and additionally uses strict canonical schemas for the Reliability v1 catalog.
- [`13d70952`](https://github.com/codexu/note-gen/commit/13d70952): guard streamed Chat Completions chunks whose `choices` array is absent or empty.
- [`f0c37188`](https://github.com/codexu/note-gen/commit/f0c37188): use a short bounded editor-state poll after a successful editor write before concluding that no change occurred. Other synchronization changes from that commit were not imported.

## Design references, independently reimplemented

- [`bd35e98a`](https://github.com/codexu/note-gen/commit/bd35e98a): permission and tool-execution restructuring informed the separation between catalog, validation, scoped approval and execution.
- [`49e75f2c`](https://github.com/codexu/note-gen/commit/49e75f2c): failure-continuation behavior informed explicit structured tool errors and partial-result semantics.
- [`d45599aa`](https://github.com/codexu/note-gen/commit/d45599aa): execution-status and interruption preservation informed terminal outcomes, trace events and stop behavior.

CardMind's runtime ports, retry policy, timeout state machine, operation-key
deduplication, trace redaction and replay evaluator are derivative-project
changes implemented against the frozen base. This document records source
provenance; it is not a claim that those mechanisms were authored from zero.
