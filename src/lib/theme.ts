/** Light / dark choice. `system` follows `prefers-color-scheme` (see `src/theme-light.css`). */
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'rec_dec.theme';

/** Stored choice; `system` when unset or storage is unavailable (private windows, blocked site data). */
export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* the choice just won't persist */
  }
}

/** `data-theme` on `<html>`: absent for `system`, so the stylesheet's media query decides. */
export function applyThemePreference(pref: ThemePreference): void {
  const el = document.documentElement;
  if (pref === 'system') delete el.dataset.theme;
  else el.dataset.theme = pref;
}
