import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtractedIfcModel } from "./modelRequirementsTypes.ts";

const execFileAsync = promisify(execFile);

export async function extractIfcModelFromFile(ifcPath: string, timeoutMs = 30000): Promise<ExtractedIfcModel> {
    const python = process.env.IDS_PYTHON_EXECUTABLE ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe");
    const script = path.resolve(process.cwd(), "python", "ifc_extract.py");
    const { stdout } = await execFileAsync(python, [script, "--ifc", ifcPath], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim());
    if (!result || typeof result.inventoryData !== "object") throw new Error("IFC extraction returned an invalid result.");
    return result;
}
