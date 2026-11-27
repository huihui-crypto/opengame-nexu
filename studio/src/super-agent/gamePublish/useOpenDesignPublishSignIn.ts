import { useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../../shared/provider-directory';
import type { EntitlementHookId } from '../../../../tracking/events.ts';
import { useI18n } from '../../i18n/I18n';
import { useAccountSummary } from '../../motion/AccountSettings';
import { gatewayRequest } from '../../motion/gatewayClient';
import { reportEntitlementGateClick, reportEntitlementGateView } from '../../motion/pageTracking';
import { newTrackingId, send } from '../../motion/reporting';
import { notifyProvidersChanged } from '../../motion/useProviderDirectory';
import { gamePublishActions } from './gamePublishStore';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/**
 * Shared sign-in flow for publishing an OpenDesign play link from the publish panel,
 * conversation failure card, or Telegram LinkStep. Auto-publishes the link once sign-in finishes.
 */
export function useOpenDesignPublishSignIn(
  artifactId: string,
  onNotify?: Notify,
  hookId: EntitlementHookId = 'game_publish_panel_signin',
  surfaceVisible = true,
) {
  const { t } = useI18n();
  const { account, setAccount } = useAccountSummary();
  const [signingIn, setSigningIn] = useState(false);
  const pendingPublishRef = useRef(false);
  const prevStateRef = useRef<AccountSummary['state'] | undefined>(undefined);
  const gateReportedRef = useRef(false);

  const signedIn = account?.state === 'signed-in';
  const authorizing = account?.state === 'authorizing';

  useEffect(() => {
    if (!surfaceVisible || !account || signedIn || authorizing) {
      gateReportedRef.current = false;
      return;
    }
    if (gateReportedRef.current) return;
    gateReportedRef.current = true;
    reportEntitlementGateView('creative_studio', hookId, {
      publish_target: 'game',
      studio_id: 'game',
    });
  }, [surfaceVisible, account, signedIn, authorizing, hookId]);

  useEffect(() => {
    if (prevStateRef.current !== 'signed-in' && signedIn && pendingPublishRef.current) {
      pendingPublishRef.current = false;
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      void gamePublishActions.publishLink(artifactId);
    } else if (prevStateRef.current === 'authorizing' && !authorizing && !signedIn) {
      pendingPublishRef.current = false;
    }
    prevStateRef.current = account?.state;
  }, [account?.state, authorizing, signedIn, artifactId]);

  async function startSignIn() {
    const entryId = newTrackingId();
    reportEntitlementGateClick('creative_studio', 'start_sign_in', hookId, {
      studio_id: 'game',
      publish_target: 'game',
      entry_id: entryId,
    });
    setSigningIn(true);
    pendingPublishRef.current = true;
    try {
      const next = await gatewayRequest<AccountSummary>('settings/account/login', 'POST', {
        hookId,
        entryId,
      });
      setAccount(next);
      window.dispatchEvent(new Event('motion:account-changed'));
      send('web_publish_result', {
        publish_target: 'game',
        action: 'sign_in',
        outcome: next.state === 'signed-in' || next.state === 'authorizing' ? 'success' : 'failure',
        publish_attempt_id: newTrackingId(),
        hook_id: hookId,
        entry_id: entryId,
      });
      if (next.state === 'signed-in') {
        pendingPublishRef.current = false;
        void gamePublishActions.publishLink(artifactId);
      }
    } catch {
      pendingPublishRef.current = false;
      send('web_publish_result', {
        publish_target: 'game',
        action: 'sign_in',
        outcome: 'failure',
        publish_attempt_id: newTrackingId(),
        hook_id: hookId,
        entry_id: entryId,
      });
      onNotify?.(t("Couldn't start OpenDesign sign-in. Try again."), 'error');
    } finally {
      setSigningIn(false);
    }
  }

  return { account, signedIn, authorizing, signingIn, startSignIn };
}
