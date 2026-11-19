import { validateRunConfig } from '../../core/config/validate.js';
import type { StoredRunMeta } from '../../app/idb-store.js';
import type { DraftStore } from '../state/draft-store.js';
import type { ThemeId } from '../state/ui-store.js';

export interface RestoredSettings {
  readonly theme: ThemeId;
  readonly speed: number;
}

export function restoreSettingsFromStorage(): RestoredSettings {
  let theme: ThemeId = 'paper';
  let speed = 1;
  try {
    const settingsRaw = localStorage.getItem('stratify.settings.v1');
    if (settingsRaw !== null) {
      const parsed = JSON.parse(settingsRaw) as Record<string, unknown>;
      if (parsed['theme'] === 'paper' || parsed['theme'] === 'obsidian') {
        theme = parsed['theme'];
      }
      if (typeof parsed['speed'] === 'number' && [0, 1, 5, 20].includes(parsed['speed'])) {
        speed = parsed['speed'];
      }
    } else {
      const legacyTheme = localStorage.getItem('stratify.theme.v1');
      if (legacyTheme === 'paper' || legacyTheme === 'obsidian') {
        theme = legacyTheme;
      }
    }
    document.documentElement.dataset['theme'] = theme;
  } catch {
    // 忽略本地偏好读取异常
  }
  return { theme, speed };
}

export function persistSettingsToStorage(theme: ThemeId, speed: number): void {
  try {
    localStorage.setItem('stratify.settings.v1', JSON.stringify({ theme, speed }));
    localStorage.setItem('stratify.theme.v1', theme);
  } catch {
    // 本地存储受限时忽略
  }
}

export function restoreLastConfigToDraft(draft: DraftStore): void {
  try {
    const raw = localStorage.getItem('stratify.lastConfig.v1');
    if (raw === null) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const check = validateRunConfig(parsed['config']);
    if (!check.ok) return;
    draft.draftConfig.set(check.config);
    if (typeof parsed['seed'] === 'string' && parsed['seed'].trim() !== '') {
      draft.draftSeed.set(parsed['seed']);
    }
    if (
      parsed['policy'] === 'mock-weighted-v1' ||
      parsed['policy'] === 'mock-weighted-v2' ||
      parsed['policy'] === 'random-uniform-v1' ||
      parsed['policy'] === 'jev_live'
    ) {
      draft.draftPolicy.set(parsed['policy']);
    }
    if (parsed['promptStyle'] === 'neutral' || parsed['promptStyle'] === 'survival_hint') {
      draft.livePromptStyle = parsed['promptStyle'];
    }
    if (typeof parsed['presetId'] === 'string') {
      draft.selectedPresetId.set(parsed['presetId']);
    }
  } catch {
    // 忽略损坏草案
  }
}

export function persistLastConfigFromDraft(draft: DraftStore): void {
  try {
    // 严格禁止写入 liveApiKey 等任何密钥字段（06 §8）
    localStorage.setItem(
      'stratify.lastConfig.v1',
      JSON.stringify({
        presetId: draft.selectedPresetId.get(),
        seed: draft.draftSeed.get(),
        policy: draft.draftPolicy.get(),
        promptStyle: draft.livePromptStyle,
        config: draft.draftConfig.get(),
      }),
    );
  } catch {
    // 本地存储受限时忽略
  }
}

export function persistRecentRunsMeta(runs: readonly StoredRunMeta[]): void {
  try {
    localStorage.setItem('stratify.recentRuns.v1', JSON.stringify(runs.slice(0, 10)));
  } catch {
    // ignore
  }
}
