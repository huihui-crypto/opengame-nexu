import { useCallback, useEffect, useRef } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import type { EntitlementHookId, ProviderSetupEntry } from '../../../tracking/events.ts';
import { gatewayRequest } from './gatewayClient';
import { newTrackingId, reportEntitlementRefresh, settingsEntryFrom, type AttributionModality } from './pageTracking';
import type { Fields } from './reporting';
import { notifyProvidersChanged } from './useProviderDirectory';

type AttributionKind = 'sign_in' | 'subscription';
export type AttributionContext = {
  studioId?: string;
  modality?: AttributionModality;
  entryFrom?: ProviderSetupEntry;
};
export type EntryAttribution = {
  hookId: EntitlementHookId;
  entryId: string;
  studioId?: string;
  modality?: AttributionModality;
  entryFrom?: ProviderSetupEntry;
};
export type ConsumedAttribution = EntryAttribution;
type PendingAttribution = EntryAttribution & { expiresAt: number };
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingByKind = new Map<AttributionKind, PendingAttribution>();

/** Carries a touchpoint's hook_id, entry_id and scene context across in-app navigation into Settings sign-in or subscription POST. */
export function setPendingAttribution(
  kind: AttributionKind,
  hookId: EntitlementHookId,
  entryId: string,
  context?: AttributionContext,
) {
  pendingByKind.set(kind, {
    hookId,
    entryId,
    ...(context?.studioId ? { studioId: context.studioId } : {}),
    ...(context?.modality ? { modality: context.modality } : {}),
    ...(context?.entryFrom ? { entryFrom: context.entryFrom } : {}),
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

export function consumePendingAttribution(kind: AttributionKind, fallbackHookId: EntitlementHookId): EntryAttribution {
  const entry = pendingByKind.get(kind);
  pendingByKind.delete(kind);
  if (entry && entry.expiresAt > Date.now()) {
    return {
      hookId: entry.hookId,
      entryId: entry.entryId,
      ...(entry.studioId ? { studioId: entry.studioId } : {}),
      ...(entry.modality ? { modality: entry.modality } : {}),
      ...(entry.entryFrom ? { entryFrom: entry.entryFrom } : {}),
    };
  }
  return { hookId: fallbackHookId, entryId: newTrackingId() };
}

export function resolveSettingsAttribution(attribution: EntryAttribution): EntryAttribution {
  const entryFrom = attribution.entryFrom ?? settingsEntryFrom();
  const studioId = attribution.studioId ?? (
    entryFrom === 'agent_game_publish_signed_out'
      ? 'game'
      : entryFrom === 'agent_design_deploy_signed_out'
        ? 'design'
        : undefined
  );
  return {
    hookId: attribution.hookId,
    entryId: attribution.entryId,
    ...(studioId ? { studioId } : {}),
    ...(attribution.modality ? { modality: attribution.modality } : {}),
    ...(entryFrom ? { entryFrom } : {}),
  };
}

/** Normalized plan name only when the account is signed in and billing data is readable. */
export function readAccountPlan(summary: AccountSummary | null | undefined): string | undefined {
  return summary?.state === 'signed-in' && !summary.billingUnavailable
    ? summary.plan?.trim().toLowerCase() || undefined
    : undefined;
}

export function evaluateEntitlementRefresh(
  prevPlan: string | undefined,
  updated: AccountSummary | null | undefined,
): { billingOk: boolean; planChanged: boolean } {
  const billingOk = Boolean(updated && updated.state === 'signed-in' && !updated.billingUnavailable);
  const nextPlan = readAccountPlan(updated);
  const planChanged = Boolean(billingOk && prevPlan && nextPlan && nextPlan !== prevPlan);
  return { billingOk, planChanged };
}

export function captureCurrentPlan(): Promise<string | undefined> {
  return gatewayRequest<AccountSummary>('settings/account')
    .then(summary => readAccountPlan(summary))
    .catch(() => undefined);
}

/** Shared post-checkout account refresh and attribution reporting. */
export function refreshEntitlementAfterCheckout(
  trackingPage: NonNullable<Fields<'entitlement_refresh_result'>['page_name']>,
  hookId: EntitlementHookId,
  entryId: string,
  prevPlanPromise: Promise<string | undefined> = Promise.resolve(undefined),
  onError?: (message: string) => void,
  context?: AttributionContext,
): Promise<void> {
  const extra = {
    ...(context?.studioId ? { studio_id: context.studioId } : {}),
    ...(context?.modality ? { modality: context.modality } : {}),
    ...(context?.entryFrom ? { entry_from: context.entryFrom } : {}),
  };
  return Promise.all([prevPlanPromise, gatewayRequest<AccountSummary>('settings/account?refresh=true')])
    .then(([prevPlan, updated]) => {
      const { billingOk, planChanged } = evaluateEntitlementRefresh(prevPlan, updated);
      reportEntitlementRefresh(trackingPage, hookId, entryId, billingOk ? 'success' : 'failure', planChanged, extra);
      if (billingOk) {
        notifyProvidersChanged();
        window.dispatchEvent(new Event('motion:account-changed'));
      }
    })
    .catch((error: unknown) => {
      reportEntitlementRefresh(trackingPage, hookId, entryId, 'failure', false, extra);
      if (onError) onError(error instanceof Error ? error.message : String(error));
    });
}

/** Shared checkout-return listener for PricingEntry, BlackFridayTopBanner, and Studio gates. */
export function useCheckoutReturnRefresh(
  trackingPage: NonNullable<Fields<'entitlement_refresh_result'>['page_name']>,
  hookId: EntitlementHookId,
  context?: AttributionContext,
) {
  const pendingRef = useRef<{ entryId: string; prevPlanPromise: Promise<string | undefined> } | undefined>(undefined);
  const studioId = context?.studioId;
  const modality = context?.modality;
  const entryFrom = context?.entryFrom;

  useEffect(() => {
    const refreshContext: AttributionContext = {
      ...(studioId ? { studioId } : {}),
      ...(modality ? { modality } : {}),
      ...(entryFrom ? { entryFrom } : {}),
    };
    const onReturn = () => {
      const pending = pendingRef.current;
      if (!pending || document.visibilityState !== 'visible') return;
      pendingRef.current = undefined;
      void refreshEntitlementAfterCheckout(trackingPage, hookId, pending.entryId, pending.prevPlanPromise, undefined, refreshContext);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [trackingPage, hookId, studioId, modality, entryFrom]);

  return useCallback((entryId: string) => {
    pendingRef.current = { entryId, prevPlanPromise: captureCurrentPlan() };
  }, []);
}
