import { Button } from 'open-design-ui/button';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { AccountStatus, useAccountSignIn } from './AccountSettings';
import { useRef, type ReactNode } from 'react';
import { MultimodalOfferCard, MultimodalUpgradeCard } from './MultimodalOfferCard';
import { useI18n } from '../i18n/I18n';
import type { StudioDestination } from './creativeStudios';
import { captureCurrentPlan, refreshEntitlementAfterCheckout } from './entitlementAttribution';
import { destinationTarget, reportCreativeClick } from './exploreTracking';
import { reportOfferClick, type OfferKind, type OfferVisit } from './offerTracking';
import { useSubscriptionOpener } from './useSubscriptionOpener';
import { RemixIcon } from '../icons/RemixIcons';
import styles from './GenerationOffer.module.css';

export function ProviderSetupNotice({ message, children }: {
  message: string; children: ReactNode;
}) {
  return <div className="om-creation-setup om-provider-setup" role="status">
    <RemixIcon name="information-line" size={18} />
    <p className="om-muted">{message}</p>
    <div className="om-control-row">{children}</div>
  </div>;
}

function generationOfferCopy({ scene }: StudioDestination, kind: OfferKind) {
  if (scene.modality === 'image') return {
    title: '7 days of unlimited flagship image generation',
    details: kind === 'upgrade' ? 'Annual Pro & Max · Up to 50% off' : 'Annual Pro & Max',
  };
  return {
    title: 'Black Friday: up to 50% off your first year',
    details: 'Enjoy this offer with Plus or higher',
  };
}

export function GenerationUpgradeNotice({ destination, onError, onUpgrade, visit }: { visit?: OfferVisit; destination: StudioDestination; onError: (message: string) => void; onUpgrade: () => void }) {
  const { t } = useI18n();
  const prevPlanRef = useRef<Promise<string | undefined> | undefined>(undefined);
  const subscription = useSubscriptionOpener(
    (element, attribution) => {
      reportCreativeClick('creative_studio', 'asset_create', element, destinationTarget(destination), attribution);
    },
    onError,
    checkout => {
      void refreshEntitlementAfterCheckout('creative_studio', checkout.hookId, checkout.entryId, prevPlanRef.current, onError, checkout);
    },
  );
  const trackedSubscription = {
    ...subscription,
    openSubscription: (...args: Parameters<typeof subscription.openSubscription>) => {
      prevPlanRef.current = captureCurrentPlan();
      return subscription.openSubscription(...args);
    },
  };
  const { title, details } = generationOfferCopy(destination, 'upgrade');
  return <MultimodalUpgradeCard
    subscription={trackedSubscription}
    visit={visit}
    model={destination.model ?? undefined}
    onUpgrade={onUpgrade}
    title={t(title)}
    details={t(details)}
    buttonLabel={t('Upgrade', undefined, 'generation offer')}
    manage
  />;
}

export function GenerationSignInNotice({ destination, onSignIn, visit }: { visit?: OfferVisit; destination: StudioDestination; onSignIn: () => void }) {
  const { t } = useI18n(), toast = useToast();
  const { state, busy, action, trackBrowserSignIn } = useAccountSignIn(destination, toast.showToast);
  const retry = !state.account && state.error;
  const { title, details } = generationOfferCopy(destination, 'sign_in');
  const signInCard = (onClick: () => void) => <MultimodalOfferCard kind="sign_in" visit={state.account ? visit : undefined} title={t(title)} details={t(details)}>
    <Button variant="plain" className={styles.signInButton} disabled={state.account ? busy : !state.error} onClick={onClick}>
      {t(retry ? 'Retry' : 'Sign in now')}
      <RemixIcon name={retry ? 'refresh-line' : 'arrow-right-up-line'} size={12} />
    </Button>
  </MultimodalOfferCard>;
  return <>
    {state.account ? <AccountStatus account={state.account} busy={busy} showToast={toast.showToast} onOpenBrowserSignIn={trackBrowserSignIn} renderSignIn={() => signInCard(() => {
        onSignIn();
        void action('login', visit && reportOfferClick(visit, 'sign_in', destination.model));
      })}
      action={name => { if (name === 'login') onSignIn(); return action(name); }} />
      : signInCard(() => void state.refresh())}
    <StudioToastViewport {...toast} />
  </>;
}
