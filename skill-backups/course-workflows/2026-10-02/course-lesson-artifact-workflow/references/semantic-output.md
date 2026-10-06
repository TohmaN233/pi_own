# Semantic output

This new-lesson workflow requires the author to return both `lessonDraft` and `files`. Neither output is optional, and a file-only revision uses a separate workflow. The lesson draft has:

```json
{
  "title": "A specific lesson title",
  "objectives": ["An observable objective"],
  "prerequisites": ["Needed background"],
  "misconceptions": ["A specific likely misconception"],
  "segments": [{"minutes": 10, "title": "Subject", "teacherAction": "Explanation or feedback", "learnerAction": "A concrete action", "checkForUnderstanding": "Evidence"}],
  "examples": ["A substantive worked example"],
  "exercises": ["An actual problem"],
  "visualRequests": [],
  "notes": ["Teacher planning notes"]
}
```

Segments total the course's session duration. The Host supplies week, session, materialIds, parents, identities, revisions and approval state. Do not put these fields in lessonDraft.

Each new files entry is `{"format":"tex", "path":"sources/descriptive-name.tex"}` or `{"format":"rmd", "path":"sources/descriptive-name.Rmd"}`. Choose the new artifact filename yourself, then write that file beneath `sources/`. Do not copy an existing context path or a `write_workspace` result's hash into structured output. TeX entries may include `documentKind:"beamer"` and `expectedPages:16` when appropriate. Rmd entries include `outputMode:"knit"` unless a rendered Rmd document is specifically requested and Pandoc is qualified. Optional file fields are omitted rather than invented.

`write_workspace` creates these new UTF-8 files using `expected_sha256:null`. Tool-result metadata does not belong in semantic output. File paths are relative to the task workspace, with no absolute paths, traversal or paths outside `sources/`. The commit Host reads the actual files and supplies `source:{path,sha256,bytes}` in its output. Compilation consumes those complete Host references through graph bindings. The legacy commit input `source:{path,sha256}` remains available to trusted callers for compatibility; the new-lesson author supplies only its newly chosen `path`, never `source` or a hash. Supplying both `path` and `source` in one entry fails explicitly.

Root Run inputs are `taskId`, the teacher's `task`, the Host constant `kind:"bundle"`, `commitRequestId` and `compileRequestId`. The graph binds `input:kind` to `commit.kind`; the author does not return `kind`. Bind the Host-created `taskId` and both stable request IDs directly from those Root inputs. Bind each CAS hash from the preceding Host tool's required top-level `bindingSha256` output, not its nested `binding.sha256`: compact Workflow bindings select top-level activity outputs. The top-level value is exactly equal to the retained nested value, which remains available for external CAS auditing. Bind commit's semantic `lessonDraft` and new `files` paths from author output; bind compile's complete `files` references and new top-level `bindingSha256` from commit output. Every identity/reference field comes from an explicit Root input or Host tool output through graph bindings. Neither the author nor a final Main copies mechanical identities or hashes. The final compile boolean is Host evidence, not author output.
