"""
Gera fixtures IFC4 controladas (perfil suportado/testado do projeto) para a
identidade persistente de espaços e equipamentos. NUNCA altera ficheiros
históricos reais — só cria ficheiros novos.

Uso:
  python make_space_fixture.py <saida.ifc> --space CODIGO:Nome[:GUID] [--space ...]
  python make_space_fixture.py <saida.ifc> --space "R-101:Sala 101"          # GUID novo
  python make_space_fixture.py <saida.ifc> --space ":Sala Sem Codigo"        # sem Reference
  ... --element "R-101|EQP-000123:Betoneira[:GUID][:SERIAL][:OBJECTTYPE]"

Cada --element cria um IfcBuildingElementProxy contido no espaço cujo código
Pset_SpaceCommon.Reference é o prefixo antes de '|':
  - TAG (ex.: EQP-000123) vai para o atributo IfcElement.Tag — o código
    institucional do gestor no perfil atual (vazio = sem Tag, para testar o
    preflight EQUIPMENT-/PROXY-);
  - SERIAL opcional vai para Pset_ManufacturerOccurrence.SerialNumber
    (evidência da instância física — separada da Tag);
  - OBJECTTYPE opcional vai para o atributo ObjectType do proxy (default:
    "Equipamento Gerido"; usa o valor literal NONE para o omitir e testar o
    PROXY-001; whitespace é preservado tal e qual).

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
import ifcopenshell.api.spatial
import ifcopenshell.util.element
import ifcopenshell.guid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--space", action="append", default=[],
                        help="CODIGO:Nome[:GUID] — CODIGO vazio omite o pset")
    parser.add_argument("--element", action="append", default=[],
                        help="SPACEREF|TAG:Nome[:GUID][:SERIAL][:OBJECTTYPE] (OBJECTTYPE=NONE omite)")
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

    # elementos contidos em espaços (por código do espaço)
    spaces_by_code = {}
    for sp in model.by_type("IfcSpace"):
        try:
            psets = ifcopenshell.util.element.get_psets(sp)
        except Exception:
            psets = {}
        code = psets.get("Pset_SpaceCommon", {}).get("Reference")
        if code:
            spaces_by_code[code] = sp

    for spec in args.element:
        space_ref, rest = spec.split("|", 1)
        parts = rest.split(":")
        tag = parts[0]
        name = parts[1] if len(parts) > 1 else "Element"
        guid = parts[2] if len(parts) > 2 and parts[2] else ifcopenshell.guid.new()
        serial = parts[3] if len(parts) > 3 and parts[3] else None
        object_type = parts[4] if len(parts) > 4 else "Equipamento Gerido"

        target = spaces_by_code.get(space_ref)
        if target is None:
            print(f"AVISO: espaço {space_ref!r} não encontrado — elemento {name!r} ignorado")
            continue

        el = ifcopenshell.api.root.create_entity(model, ifc_class="IfcBuildingElementProxy", name=name)
        el.GlobalId = guid
        ifcopenshell.api.spatial.assign_container(model, products=[el], relating_structure=target)

        # Tag institucional do gestor (perfil EQP-): atributo IfcElement.Tag.
        # Vazio = sem Tag (fixture negativa para o preflight).
        if tag != "":
            el.Tag = tag

        # ObjectType: classificação do modelador exigida nos proxies
        # (PROXY-001). NONE omite; whitespace é preservado tal e qual.
        if object_type != "NONE":
            el.ObjectType = object_type

        # Serial: evidência da instância física, SEPARADA da Tag.
        if serial:
            pset2 = ifcopenshell.api.pset.add_pset(model, product=el, name="Pset_ManufacturerOccurrence")
            ifcopenshell.api.pset.edit_pset(model, pset=pset2, properties={"SerialNumber": serial})

        print(f"Elemento: guid={guid} name={name!r} tag={tag!r} serial={serial!r} "
              f"objectType={(None if object_type == 'NONE' else object_type)!r} em {space_ref}")

    model.write(args.output)
    print(f"Escrito: {args.output}")


if __name__ == "__main__":
    main()
