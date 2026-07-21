# Controlled model-intake inputs

These repository files are public, synthetic examples. The workspace never selects or uploads them automatically: the researcher controls each file picker.

- `model-v1.ifc` contains room `R-101` and managed equipment `EQP-DEMO-001` on Synthetic Level 1.
- `model-v2-same-identities.ifc` uses different IFC GUIDs and a changed label/storey context while preserving the same Reference, Tag and serial. This makes persistent identity continuity observable.
- `ids-reference-required.ids` asks for the room Reference and equipment Tag that V1 provides.
- `ids-reference-and-extra-property.ids` asks for an additional Department property deliberately absent from V1, so changing only IDS changes the result.

Use `/dashboard`: select an existing logical model line, choose an IFC, choose active IDS or upload one of these IDS files, and then run **Validate and preview**. Version creation is a separate explicit action.
