import { isCancel, multiselect } from "@clack/prompts";
import type { Preset } from "./presets.ts";

/** Checkbox list of presets. Ones already fully blocked are shown but can't be toggled. */
export async function promptForPresets(presets: Preset[], listed: string[]): Promise<string[] | null> {
  const blocked = (preset: Preset) => preset.hosts.every((host) => listed.includes(host));
  const result = await multiselect({
    message: "Which sites should focus block?",
    options: presets.map((preset) => ({
      value: preset.id,
      label: preset.name,
      hint: blocked(preset) ? "already blocked" : preset.note,
      disabled: blocked(preset),
    })),
    initialValues: presets.filter((preset) => preset.recommended && !blocked(preset)).map((preset) => preset.id),
    required: false,
  });
  return isCancel(result) ? null : result;
}
