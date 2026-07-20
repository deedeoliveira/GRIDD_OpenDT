"""IfcTester-backed IDS execution boundary.

Stdout is one normalized JSON document. The script never emits IFC or IDS
contents and deliberately sanitizes execution errors for its caller.
"""

import argparse
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

import ifcopenshell
from ifctester import ids, reporter


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def simple_value(value):
    if not isinstance(value, dict):
        return None
    if "simpleValue" in value:
        return value["simpleValue"]
    return None


def safe_text(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return str(value)[:1000]


def friendly_message(specification, requirement, failure=None):
    label = requirement.get("label") or specification.get("name") or "IDS requirement"
    if label == "Pset_SpaceCommon.Reference" and failure:
        reason = str(failure.get("reason", ""))
        if "does not exist" in reason or "does not have" in reason or "not provided" in reason:
            return "The space is missing Pset_SpaceCommon.Reference."
    if failure:
        return f"{label}: {str(failure.get('reason') or 'requirement not satisfied')[:500]}"
    return f"{label} is satisfied."


def normalize(report):
    findings = []
    requirement_count = 0
    for spec_index, specification in enumerate(report.get("specifications", []), start=1):
        for req_index, requirement in enumerate(specification.get("requirements", []), start=1):
            requirement_count += 1
            metadata = requirement.get("metadata", {})
            property_set = simple_value(metadata.get("propertySet"))
            property_name = simple_value(metadata.get("baseName")) or simple_value(metadata.get("name"))
            requirement_id = f"IDS-{spec_index:02d}-{req_index:02d}"
            failures = requirement.get("failed_entities", []) or []
            if failures:
                for failure in failures:
                    findings.append({
                        "source": "ids",
                        "requirementId": requirement_id,
                        "requirementName": requirement.get("label") or specification.get("name"),
                        "status": "fail",
                        "severity": "error",
                        "entityType": failure.get("class"),
                        "entityGuid": failure.get("global_id"),
                        "propertySet": property_set,
                        "propertyName": property_name,
                        "expectedValue": safe_text(requirement.get("value")),
                        "actualValue": None,
                        "message": friendly_message(specification, requirement, failure),
                    })
            else:
                findings.append({
                    "source": "ids",
                    "requirementId": requirement_id,
                    "requirementName": requirement.get("label") or specification.get("name"),
                    "status": "pass" if requirement.get("status") is not False else "fail",
                    "severity": "info" if requirement.get("status") is not False else "error",
                    "entityType": None,
                    "entityGuid": None,
                    "propertySet": property_set,
                    "propertyName": property_name,
                    "expectedValue": safe_text(requirement.get("value")),
                    "actualValue": None,
                    "message": friendly_message(specification, requirement),
                })
    return findings, requirement_count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ifc")
    parser.add_argument("--ids", required=True)
    parser.add_argument("--correlation-id", required=True)
    parser.add_argument("--validate-profile-only", action="store_true")
    args = parser.parse_args()

    profile_path = Path(args.ids).resolve()
    profile = ids.open(str(profile_path), validate=True)
    common = {
        "correlationId": args.correlation_id,
        "profileVersion": str(profile.info.get("version") or "unknown"),
        "profileSha256": sha256(profile_path),
        "executorName": "IfcTester",
        "executorVersion": importlib.metadata.version("ifctester"),
    }
    if args.validate_profile_only:
        print(json.dumps({**common, "profileValid": True, "specificationCount": len(profile.specifications)}))
        return
    if not args.ifc:
        raise ValueError("--ifc is required for model validation")

    ifc_path = Path(args.ifc).resolve()
    model = ifcopenshell.open(str(ifc_path))
    profile.validate(model)
    rendered = reporter.Json(profile)
    rendered.report()
    findings, count = normalize(rendered.results)
    conforms = all(spec.status is True for spec in profile.specifications)
    print(json.dumps({
        **common,
        "ifcSchema": model.schema_identifier,
        "fileSha256": sha256(ifc_path),
        "conforms": conforms,
        "requirementsEvaluated": count,
        "successCount": sum(1 for item in findings if item["status"] == "pass"),
        "failureCount": sum(1 for item in findings if item["status"] == "fail"),
        "findings": findings,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "error": "IDS validation could not be completed.",
            "errorType": type(error).__name__,
        }))
        sys.exit(2)
