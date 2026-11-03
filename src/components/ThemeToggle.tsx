import { useState } from 'react';
import { applyThemePreference, readThemePreference, saveThemePreference, type ThemePreference } from '../lib/theme.ts';

const NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemePreference, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

/** Cycles Auto (follow the system) → Light → Dark. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(readThemePreference);
  return (
    <button
      type="button"
      onClick={() => {
        const next = NEXT[pref];
        setPref(next);
        saveThemePreference(next);
        applyThemePreference(next);
      }}
      className="text-sm text-gray-500 hover:text-gray-300"
      title={`Theme: ${LABEL[pref]}. Click for ${LABEL[NEXT[pref]]}.`}
      aria-label={`Theme: ${LABEL[pref]}. Switch to ${LABEL[NEXT[pref]]}.`}
    >
      Theme: {LABEL[pref]}
    </button>
  );
}
