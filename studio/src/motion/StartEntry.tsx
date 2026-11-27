import { useState, type MouseEvent } from 'react';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../icons/RemixIcons';
import type { AccountSummary } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { gatewayRequest } from './gatewayClient';
import { notifyProvidersChanged } from './useProviderDirectory';
import type { CreativePage } from './exploreTracking';
import { newTrackingId } from './reporting';
import { trackMotion } from './tracking';
import styles from './StartEntry.module.css';

/**
 * Top-right call to action for visitors who are not signed in: it takes the avatar's place. One click starts the
 * OpenDesign browser sign-in (the same handoff as Settings > Account) and the visitor stays on the current page; the
 * header follows the sign-in and turns into the avatar once it completes. Only when sign-in cannot start does it open
 * Settings > Account, where the reason is shown. While waiting, a click reopens the browser sign-in page.
 */
export function StartEntry({ account, trackingPage, openAccount }: { account: AccountSummary; trackingPage: CreativePage; openAccount: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const authorizing = account.state === 'authorizing';

  async function start(event: MouseEvent) {
    const interactionMethod = event.detail === 0 ? 'keyboard' : 'pointer';
    if (authorizing) {
      if (account.authorizationUrl) {
        void trackMotion('ui_click', {
          page_name: trackingPage,
          area: 'header',
          element: 'open_browser_signin',
          hook_id: 'header_signin',
          interaction_method: interactionMethod,
        });
        window.open(account.authorizationUrl, '_blank', 'noopener,noreferrer');
      } else {
        void trackMotion('ui_click', {
          page_name: trackingPage,
          area: 'header',
          element: 'start_sign_in',
          hook_id: 'header_signin',
          interaction_method: interactionMethod,
        });
        openAccount();
      }
      return;
    }
    const entryId = newTrackingId();
    void trackMotion('ui_click', {
      page_name: trackingPage,
      area: 'header',
      element: 'start_sign_in',
      hook_id: 'header_signin',
      entry_id: entryId,
      interaction_method: interactionMethod,
    });
    setBusy(true);
    try {
      const started = await gatewayRequest<AccountSummary>('settings/account/login', 'POST', {
        hookId: 'header_signin',
        entryId,
      });
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      // A sign-in that fails as it starts still answers normally: show its reason and recovery.
      if (started?.errorCode && started.state !== 'authorizing' && started.state !== 'signed-in') openAccount();
    } catch {
      // Settings > Account reads the account again and shows why sign-in could not start.
      openAccount();
    } finally {
      setBusy(false);
    }
  }

  return <Button variant="plain" type="button" className={styles.start} disabled={busy} onClick={event => void start(event)}>
    <RemixIcon className={styles.icon} name="sparkling-fill" size={14} />
    <span>{t(authorizing ? 'Signing in…' : 'Get started')}</span>
  </Button>;
}
