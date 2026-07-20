"""Generate the public IDS profile and the three synthetic IFC demo fixtures.

This development utility uses the same IfcOpenShell/IfcTester stack as the
runtime. Generated files contain only deliberately synthetic identifiers.
"""

from pathlib import Path

import ifcopenshell
import ifcopenshell.api
from ifctester import ids


ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / "semantic" / "artifacts" / "runtime" / "oswadt-ifc4-model-requirements" / "1.0.0" / "oswadt-ifc4-model-requirements-v1.ids"
FIXTURES = ROOT / "back" / "tests" / "fixtures" / "ids"


def generate_profile() -> None:
    document = ids.Ids(
        title="OSWADT IFC4 synthetic model information requirements",
        version="1.0.0",
        description="Public synthetic IDS profile for functional validation demonstrations.",
        purpose="Research demonstrator",
        milestone="Prompt 7C",
    )

    spaces = ids.Specification(
        name="Spaces provide a controlled persistent Reference",
        identifier="IDS-SPACE-REFERENCE",
        description="Every IfcSpace must provide Pset_SpaceCommon.Reference using the R-000 pattern.",
        minOccurs=1,
        maxOccurs="unbounded",
        ifcVersion=["IFC4"],
    )
    spaces.applicability.append(ids.Entity(name="IFCSPACE"))
    spaces.requirements.append(
        ids.Property(
            propertySet="Pset_SpaceCommon",
            baseName="Reference",
            value=ids.Restriction({"pattern": "R-[0-9]{3}"}),
            # Pset_SpaceCommon.Reference is an IfcIdentifier in IFC4.
            dataType="IFCIDENTIFIER",
            cardinality="required",
            instructions="Provide a non-empty synthetic room code such as R-101.",
        )
    )
    document.specifications.append(spaces)

    equipment = ids.Specification(
        name="Managed demo equipment has an EQP Tag",
        identifier="IDS-EQUIPMENT-TAG",
        description="Every IfcFurnishingElement in this profile must have an EQP-prefixed Tag.",
        minOccurs=0,
        maxOccurs="unbounded",
        ifcVersion=["IFC4"],
    )
    equipment.applicability.append(ids.Entity(name="IFCFURNISHINGELEMENT"))
    equipment.requirements.append(
        ids.Attribute(
            name="Tag",
            value=ids.Restriction({"pattern": "EQP-[A-Z0-9-]+"}),
            cardinality="required",
            instructions="Use a synthetic identifier beginning with EQP-.",
        )
    )
    document.specifications.append(equipment)

    proxy = ids.Specification(
        name="Building element proxies identify their object type",
        identifier="IDS-PROXY-OBJECTTYPE",
        description="When an IfcBuildingElementProxy is present, ObjectType is required.",
        minOccurs=0,
        maxOccurs="unbounded",
        ifcVersion=["IFC4"],
    )
    proxy.applicability.append(ids.Entity(name="IFCBUILDINGELEMENTPROXY"))
    proxy.requirements.append(ids.Attribute(name="ObjectType", cardinality="required"))
    document.specifications.append(proxy)

    PROFILE.parent.mkdir(parents=True, exist_ok=True)
    if not document.to_xml(str(PROFILE)):
        raise RuntimeError("IfcTester rejected the generated IDS profile")


def _root(model, ifc_class: str, name: str, **kwargs):
    return ifcopenshell.api.run("root.create_entity", model, ifc_class=ifc_class, name=name, **kwargs)


def generate_ifc(path: Path, references: list[str | None]) -> None:
    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    project = _root(model, "IfcProject", "Synthetic IDS Demonstration Project")
    site = _root(model, "IfcSite", "Synthetic Site")
    building = _root(model, "IfcBuilding", "Synthetic Building")
    storey = _root(model, "IfcBuildingStorey", "Synthetic Level")
    ifcopenshell.api.run("aggregate.assign_object", model, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", model, products=[building], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", model, products=[storey], relating_object=building)

    spaces = []
    for index, reference in enumerate(references, start=1):
        space = _root(model, "IfcSpace", f"Synthetic Room {index}")
        ifcopenshell.api.run("aggregate.assign_object", model, products=[space], relating_object=storey)
        if reference is not None:
            pset = ifcopenshell.api.run("pset.add_pset", model, product=space, name="Pset_SpaceCommon")
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={"Reference": reference})
        spaces.append(space)

    equipment = _root(model, "IfcFurnishingElement", "Synthetic Managed Equipment")
    equipment.Tag = "EQP-DEMO-001"
    ifcopenshell.api.run("spatial.assign_container", model, products=[equipment], relating_structure=spaces[0])

    path.parent.mkdir(parents=True, exist_ok=True)
    model.write(str(path))


if __name__ == "__main__":
    generate_profile()
    generate_ifc(FIXTURES / "ids-demo-invalid-missing-reference.ifc", [None])
    generate_ifc(FIXTURES / "ids-demo-valid.ifc", ["R-101"])
    generate_ifc(FIXTURES / "ids-demo-duplicate-reference.ifc", ["R-201", "R-201"])
    print(PROFILE)
    for fixture in sorted(FIXTURES.glob("*.ifc")):
        print(fixture)
