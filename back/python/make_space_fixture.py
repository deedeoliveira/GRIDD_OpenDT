"""
Gera fixtures IFC controladas para testar a identidade persistente dos espaços
(Prompt 3). NUNCA altera ficheiros históricos reais — só cria ficheiros novos.

Uso:
  python make_space_fixture.py <saida.ifc> --space CODIGO:Nome[:GUID] [--space ...]
  python make_space_fixture.py <saida.ifc> --space "R-101:Sala 101"          # GUID novo
  python make_space_fixture.py <saida.ifc> --space ":Sala Sem Codigo"        # sem Reference
  python make_space_fixture.py <saida.ifc> --space "  :So Espacos"           # Reference whitespace

Cada --space cria um IfcSpace com Pset_SpaceCommon.Reference = CODIGO
(omitido quando CODIGO é vazio; whitespace é preservado tal e qual, para
testar validação). O GUID é gerado se não for indicado — passa o mesmo GUID
em dois ficheiros para testar "GUID igual, código diferente".
"""
import sys
import argparse
import ifcopenshell
import ifcopenshell.api.root
import ifcopenshell.api.unit
import ifcopenshell.api.context
import ifcopenshell.api.project
import ifcopenshell.api.aggregate
import ifcopenshell.api.pset
import ifcopenshell.guid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--space", action="append", default=[],
                        help="CODIGO:Nome[:GUID] — CODIGO vazio omite o pset")
    args = parser.parse_args()

    if not args.space:
        print("Indica pelo menos um --space CODIGO:Nome[:GUID]")
        sys.exit(1)

    model = ifcopenshell.api.project.create_file(version="IFC4")

    project = ifcopenshell.api.root.create_entity(model, ifc_class="IfcProject", name="FixtureProject")
    ifcopenshell.api.unit.assign_unit(model)
    site = ifcopenshell.api.root.create_entity(model, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.root.create_entity(model, ifc_class="IfcBuilding", name="Building")
    storey = ifcopenshell.api.root.create_entity(model, ifc_class="IfcBuildingStorey", name="Storey")

    ifcopenshell.api.aggregate.assign_object(model, products=[site], relating_object=project)
    ifcopenshell.api.aggregate.assign_object(model, products=[building], relating_object=site)
    ifcopenshell.api.aggregate.assign_object(model, products=[storey], relating_object=building)

    for spec in args.space:
        parts = spec.split(":")
        code = parts[0]
        name = parts[1] if len(parts) > 1 else "Space"
        guid = parts[2] if len(parts) > 2 and parts[2] else ifcopenshell.guid.new()

        space = ifcopenshell.api.root.create_entity(model, ifc_class="IfcSpace", name=name)
        space.GlobalId = guid
        space.LongName = name

        ifcopenshell.api.aggregate.assign_object(model, products=[space], relating_object=storey)

        # CODIGO vazio ⇒ sem Pset_SpaceCommon (Reference ausente);
        # caso contrário o valor é escrito TAL E QUAL (incluindo whitespace)
        if code != "":
            pset = ifcopenshell.api.pset.add_pset(model, product=space, name="Pset_SpaceCommon")
            ifcopenshell.api.pset.edit_pset(model, pset=pset, properties={"Reference": code})

        print(f"IfcSpace: guid={guid} name={name!r} Reference={code!r}" if code != "" else
              f"IfcSpace: guid={guid} name={name!r} (sem Pset_SpaceCommon)")

    model.write(args.output)
    print(f"Escrito: {args.output}")


if __name__ == "__main__":
    main()
