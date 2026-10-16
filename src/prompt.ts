import { groupMultiselect, isCancel, text } from "@clack/prompts";

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A grouped checklist (`focus config` and `focus init`); resolves to the checked values, or
 * null if cancelled. Groups can't be selected as a whole: each line is its own decision.
 */
export async function chooseOptions(message: string, groups: Record<string, Choice[]>, initial: string[]): Promise<string[] | null> {
  const result = await groupMultiselect({
    message,
    options: groups,
    initialValues: initial,
    required: false,
    selectableGroups: false,
    groupSpacing: 1,
  });
  return isCancel(result) ? null : result;
}

/** One line of text; null if cancelled. */
export async function askText(message: string, placeholder: string): Promise<string | null> {
  const result = await text({ message, placeholder });
  return isCancel(result) ? null : (result ?? "");
}
