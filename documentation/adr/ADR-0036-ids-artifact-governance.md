# ADR-0036 — IDS artifact governance

Status: accepted for implementation, pending researcher walkthrough.

## Decision

An IDS profile is a governed semantic artifact with
`artifact_type=ids_profile` and `storage_mode=file_executed`. It retains the
7B1 immutable identity, hash, semantic version, lifecycle, validation evidence
and family current pointer. Unlike RDF artifacts, it has a null named graph and
is never sent to Fuseki.

The public manifest declares IDS/XML explicitly. Activation requires integrity
validation plus successful schema/profile loading by the genuine IfcTester
executor. Executor name/version and profile-loading evidence are stored as
metadata. RDF releases remain `graph_backed` and preserve their immutable graph
behaviour.

## Consequences

The registry supports future executable file artifact families without
inventing graphs. Rollback moves the SQL current pointer and does not edit file
bytes. The 7C rollback removes file-executed revisions before restoring the
graph-only schema. No IFC, IDS XML, credential or private identifier is stored
in validation reports.
