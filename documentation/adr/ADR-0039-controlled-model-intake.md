# ADR-0039 — Researcher-controlled model intake

Status: accepted for the Prompt 7D research prototype (2026-07-20).

## Context

Preset-only demonstration buttons do not prove that researcher-selected IFC and IDS files were processed. The previous administrative dashboard was a placeholder and the existing upload API persisted immediately, so neither provided a review boundary.

## Decision

Place a six-step **Controlled model intake** workspace in the existing `/dashboard` model-management route. The researcher selects an existing linked/logical model line, an IFC, and either the active governed IDS or a temporary uploaded IDS.

`Validate and preview` sends multipart files, validates filename/content/size, computes both hashes on the backend, opens IFC with IfcOpenShell, opens IDS with genuine IfcTester, executes IDS and project rules separately, resolves candidate identities read-only and generates/round-trips Turtle in memory. It creates no model version, domain identity/binding, graph or reservation and cleans uploaded files.

`Create model version` is a separate explicit multipart action. It requires a non-expired preflight, receives the files again, recomputes and matches hashes, reruns validation and then invokes the real version pipeline. In `required` mode semantic graph verification precedes SQL activation.

Temporary IDS uploads are local/dev-only, size-limited, reject DTD/entity declarations, never enter the artifact registry and leave only sanitized run evidence. Workspace and semantic materialisation are disabled by default and refused in production without a future authenticated design.

## Consequences

- The UI never computes proof hashes, generates RDF, calls Python/Fuseki directly or creates a version during preview.
- The setup command is dry-run by default and never applies migrations or uploads examples.
- Walkthrough evidence depends on inputs selected through the file pickers, not presets.

## Product boundary and future management workflow

The current workspace selects an already registered building/model line. It is
sufficient executable evidence for controlled intake and version continuity,
but it is not the final management-interface design.

Future product work must cover this observable workflow:

1. building list;
2. building registration and creation of its persistent identity;
3. creation of the initial logical model line;
4. upload and validation of the first IFC;
5. creation of the first model version;
6. management of subsequent versions from the building page.
