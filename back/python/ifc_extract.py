"""Extract the existing project-rule input shape from a local IFC file."""

import argparse
import json

import ifcopenshell_utils


parser = argparse.ArgumentParser()
parser.add_argument("--ifc", required=True)
args = parser.parse_args()
print(json.dumps({
    "inventoryData": ifcopenshell_utils.extract_inventory_by_space(args.ifc),
    "uncontainedProxies": ifcopenshell_utils.extract_model_context(args.ifc)["uncontainedProxies"],
    "schema": ifcopenshell_utils.extract_model_context(args.ifc)["schema"],
}))
