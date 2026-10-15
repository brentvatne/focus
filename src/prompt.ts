import { isCancel, multiselect } from "@clack/prompts";
import type { Preset } from "./presets.ts";

/** Checkbox list of presets. The final selection replaces the current presets. */
export async function promptForPresets(presets: Preset[], initial: string[]): Promise<string[] | null> {
  const result = await multiselect({
    message: "Which sites should focus block?",
    options: presets.map((preset) => ({ value: preset.id, label: preset.name, hint: preset.note })),
    initialValues: initial,
    required: false,
  });
  return isCancel(result) ? null : result;
}
