"""Isolated pySHACL 0.40.0 runner. JSON is accepted on stdin; RDF never enters logs."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import sys
from datetime import datetime, timezone

from pyshacl import validate
from pyshacl.errors import ReportableRuntimeError
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import OWL, RDF

SH = Namespace("http://www.w3.org/ns/shacl#")


def text(value):
    if value is None:
        return None
    return str(value)


def first(graph: Graph, subject, predicate):
    return next(graph.objects(subject, predicate), None)


def compact_term(value):
    if value is None:
        return None
    return text(value)


def parse_turtle(payload: str, label: str) -> Graph:
    graph = Graph()
    try:
        graph.parse(data=payload, format="turtle", publicID=f"urn:oswadt:{label}")
    except Exception as exc:
        raise ValueError(f"{label} Turtle is invalid.") from exc
    return graph


def reject_imports(shapes: Graph):
    if any(True for _ in shapes.triples((None, OWL.imports, None))):
        raise ValueError("Shapes containing owl:imports are not allowed.")


def constraints(shapes: Graph):
    rows = []
    target_predicates = [SH.targetClass, SH.targetNode, SH.targetObjectsOf, SH.targetSubjectsOf]
    for shape in sorted(set(shapes.subjects(RDF.type, SH.NodeShape)), key=str):
        targets = []
        for predicate in target_predicates:
            for value in shapes.objects(shape, predicate):
                targets.append({"kind": text(predicate).split("#")[-1], "value": text(value)})
        if not targets:
            targets = [{"kind": "implicit", "value": text(shape)}]
        properties = list(shapes.objects(shape, SH.property))
        for prop in properties:
            rows.append({
                "sourceShape": text(prop),
                "nodeShape": text(shape),
                "targets": targets,
                "path": compact_term(first(shapes, prop, SH.path)),
                "minCount": int(first(shapes, prop, SH.minCount)) if first(shapes, prop, SH.minCount) is not None else None,
                "maxCount": int(first(shapes, prop, SH.maxCount)) if first(shapes, prop, SH.maxCount) is not None else None,
                "datatype": compact_term(first(shapes, prop, SH.datatype)),
                "class": compact_term(first(shapes, prop, SH["class"])),
                "nodeKind": compact_term(first(shapes, prop, SH.nodeKind)),
                "pattern": text(first(shapes, prop, SH.pattern)),
                "severity": compact_term(first(shapes, prop, SH.severity) or first(shapes, shape, SH.severity) or SH.Violation),
                "message": text(first(shapes, prop, SH.message) or first(shapes, shape, SH.message)),
            })
        for predicate, component in [(SH["class"], "class"), (SH.nodeKind, "nodeKind")]:
            value = first(shapes, shape, predicate)
            if value is not None:
                rows.append({"sourceShape": text(shape), "nodeShape": text(shape), "targets": targets,
                    "path": None, "minCount": None, "maxCount": None, "datatype": None,
                    "class": text(value) if component == "class" else None,
                    "nodeKind": text(value) if component == "nodeKind" else None,
                    "pattern": None, "severity": text(first(shapes, shape, SH.severity) or SH.Violation),
                    "message": text(first(shapes, shape, SH.message))})
    return rows


def normalized_results(report: Graph):
    rows = []
    for result in report.subjects(RDF.type, SH.ValidationResult):
        messages = [str(v) for v in report.objects(result, SH.resultMessage)]
        rows.append({
            "focusNode": text(first(report, result, SH.focusNode)),
            "resultPath": text(first(report, result, SH.resultPath)),
            "value": text(first(report, result, SH.value)),
            "sourceShape": text(first(report, result, SH.sourceShape)),
            "sourceConstraintComponent": text(first(report, result, SH.sourceConstraintComponent)),
            "severity": text(first(report, result, SH.resultSeverity)),
            "message": " | ".join(messages) if messages else None,
        })
    return rows


def main():
    request = json.load(sys.stdin)
    shapes_text = request.get("shapesTurtle")
    if not isinstance(shapes_text, str) or not shapes_text.strip():
        raise ValueError("A non-empty shapes graph is required.")
    shapes = parse_turtle(shapes_text, "shapes")
    reject_imports(shapes)
    # meta_shacl=True makes pySHACL validate the actual shapes graph against shacl-shacl.
    data_text = request.get("dataTurtle") or ""
    data = parse_turtle(data_text, "data") if data_text.strip() else Graph()
    ontology_text = request.get("ontologyTurtle")
    ontology = parse_turtle(ontology_text, "ontology") if isinstance(ontology_text, str) and ontology_text.strip() else None
    started = datetime.now(timezone.utc)
    conforms, report, _ = validate(
        data_graph=data,
        shacl_graph=shapes,
        ont_graph=ontology,
        inference=request.get("inference", "none"),
        advanced=bool(request.get("advanced", False)),
        meta_shacl=bool(request.get("metaShacl", True)),
        do_owl_imports=False,
        allow_infos=False,
        allow_warnings=False,
        serialize_report_graph=False,
    )
    report_turtle = report.serialize(format="turtle")
    if isinstance(report_turtle, bytes):
        report_turtle = report_turtle.decode("utf-8")
    completed = datetime.now(timezone.utc)
    result_rows = normalized_results(report)
    response = {
        "ok": True,
        "conforms": bool(conforms),
        "resultCount": len(result_rows),
        "results": result_rows,
        "constraints": constraints(shapes),
        "executorName": "pySHACL",
        "executorVersion": importlib.metadata.version("pyshacl"),
        "startedAt": started.isoformat(),
        "completedAt": completed.isoformat(),
        "reportTurtle": report_turtle,
        "reportSha256": hashlib.sha256(report_turtle.encode("utf-8")).hexdigest(),
    }
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, ReportableRuntimeError) as exc:
        print(json.dumps({"ok": False, "errorCode": "shacl_input_rejected", "message": str(exc).splitlines()[0]}))
        sys.exit(2)
    except Exception:
        print(json.dumps({"ok": False, "errorCode": "shacl_executor_failed", "message": "SHACL validation could not be completed."}))
        sys.exit(3)
