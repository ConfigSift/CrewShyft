export type OnboardingEntryPoint = 'persona' | 'restaurants';

export type OnboardingDraftState = {
  entryPoint?: OnboardingEntryPoint;
  organizationId?: string;
  restaurantCode?: string;
  ownerName?: string;
  restaurantName?: string;
  currency?: string;
};

const ONBOARDING_DRAFT_KEY = 'crewshyft_onboarding';

function isBrowser() {
  return typeof window !== 'undefined';
}

export function loadOnboardingDraft(): OnboardingDraftState {
  if (!isBrowser()) return {};

  try {
    const raw = window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as OnboardingDraftState;
  } catch {
    return {};
  }
}

export function replaceOnboardingDraft(draft: OnboardingDraftState) {
  if (!isBrowser()) return;

  try {
    window.sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore
  }
}

export function mergeOnboardingDraft(draft: Partial<OnboardingDraftState>) {
  if (!isBrowser()) return;

  try {
    const current = loadOnboardingDraft();
    window.sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({
      ...current,
      ...draft,
    }));
  } catch {
    // ignore
  }
}

export function clearOnboardingDraft() {
  if (!isBrowser()) return;

  try {
    window.sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // ignore
  }
}

export function hasOnboardingDraftPrefill() {
  const draft = loadOnboardingDraft();
  return Boolean(
    String(draft.ownerName ?? '').trim()
    || String(draft.restaurantName ?? '').trim()
    || String(draft.organizationId ?? '').trim(),
  );
}
