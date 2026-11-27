import { useEffect, useId, useRef } from 'react';
import { Button } from 'open-design-ui/button';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { BLACK_FRIDAY_CAMPAIGN, campaignPricingUrl, useBlackFridayActive } from '../motion/campaignAttribution';
import { reportEntitlementGateClick, reportEntitlementGateView } from '../motion/pageTracking';
import { useAccountHandoff, type AccountHandoffResume } from './useAccountHandoff';

export function AccountHandoffCard({ card, handoffKey, onResume, onOpenSettings }: {
  card: SuperAgentActionCard;
  /** Unique per chat + turn; gateway card ids repeat across turns and chats. */
  handoffKey?: string;
  onResume?: AccountHandoffResume;
  onOpenSettings?: (card: SuperAgentActionCard, target: 'account' | 'api_key') => void;
}) {
  const { locale, t } = useI18n();
  const descriptionId = useId();
  const {
    state, alreadySignedIn, signedInForPlans, entryId, hookId, beginAttempt, start, retry, cancel, refresh, openPlans,
  } = useAccountHandoff(card, onResume, handoffKey);
  const publish = card.kind === 'web_publish_sign_in';
  const signIn = card.kind === 'sign_in' || publish;
  // Exposure / click tracking matches the commercialization gate cards (#24): same hook ids, page and campaign.
  // Publish cards also carry publish_target, like the publish popover's own sign-in gate.
  const campaign = useBlackFridayActive();
  const campaignFields = {
    ...(campaign ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } as const : {}),
    ...(publish && card.targetKind ? { publish_target: card.targetKind } : {}),
  };
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current || !entryId) return;
    viewed.current = true;
    // Once per card, with the entry_id its first click reuses.
    reportEntitlementGateView('creative_studio', hookId, {
      studio_id: 'game', entry_id: entryId,
      ...(campaign ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } : {}),
      ...(publish && card.targetKind ? { publish_target: card.targetKind } : {}),
    });
  }, [entryId, hookId, campaign, publish, card.targetKind]);
  const track = (element: 'start_sign_in' | 'open_pricing', id: string) =>
    reportEntitlementGateClick('creative_studio', element, hookId, { studio_id: 'game', entry_id: id, ...campaignFields });
  const pricingUrl = entryId ? campaignPricingUrl(locale, 'opengame_agent_upgrade', entryId, { studioId: 'game', modality: 'all' }) : undefined;
  const upgradeLabel = campaign ? t('Upgrade · 50% OFF') : t('Upgrade to Plus');
  // A pricing anchor (user gesture, so popup blockers allow it) instead of a button for upgrade CTAs.
  let plansAnchor: string | undefined;
  const openPricing = () => {
    if (!pricingUrl) return;
    track('open_pricing', entryId);
    openPlans(pricingUrl);
  };
  let title = t(publish ? 'Sign in to publish online' : signIn ? 'Sign in with OpenDesign' : 'Upgrade to OpenDesign Plus');
  let description = t(publish
    ? "Sign in with OpenDesign to get a shareable web link. I'll publish again automatically once you're signed in."
    : signIn
      ? "Sign in to generate AI images, video, music and voice. I'll continue automatically once you're signed in."
      : card.kind === 'upgrade_go'
        ? "Go plan does not include AI media generation. Upgrade to Plus and I'll continue automatically."
        : "Free plan does not include AI media generation. Upgrade to Plus and I'll continue automatically.");
  let label = publish ? t('Sign in & publish') : signIn ? t('Sign in & continue') : upgradeLabel;
  let action = () => { track(signIn ? 'start_sign_in' : 'open_pricing', beginAttempt()); void start(card); };
  const retryAction = () => { track(signIn ? 'start_sign_in' : 'open_pricing', beginAttempt()); void retry(); };
  let secondary: 'cancel' | 'refresh' | 'settings' | undefined;
  let link: string | undefined;
  let disabled = false;

  switch (state.status) {
    case 'idle':
      if (alreadySignedIn) { title = t("You're signed in"); description = ''; label = t(publish ? 'Publish again' : 'Continue'); action = () => { beginAttempt(); void start(card); }; }
      else if (!signIn) {
        secondary = 'settings';
        // Already signed in on Free/Go: open the pricing page directly; otherwise sign in locally first.
        if (signedInForPlans) { plansAnchor = upgradeLabel; label = ''; }
      }
      break;
    case 'starting':
      label = t('Opening sign-in…'); disabled = true;
      break;
    case 'authorizing':
      title = t('Finish signing in in your browser');
      description = state.userCode ? t('Verification code: {code}', { code: state.userCode }) : '';
      if (state.browserOpened === false) {
        description = [description, t("Your browser didn't open — use Continue in browser.")].filter(Boolean).join(' ');
      }
      label = ''; link = state.authorizationUrl; secondary = 'cancel';
      break;
    case 'signed_in':
      title = t('Signed in. Opening plans…'); description = ''; label = '';
      break;
    case 'opening_plan':
      title = t("You're signed in");
      description = t("Upgrade to Plus and I'll continue generating here.");
      label = ''; plansAnchor = upgradeLabel;
      break;
    case 'awaiting_upgrade':
      title = t('Plans opened in your browser');
      description = t("Upgrade to Plus and I'll continue generating here.");
      label = ''; link = state.planUrl; secondary = 'refresh';
      break;
    case 'resuming':
    case 'done':
      title = t(publish ? 'Signed in — publishing again' : 'Signed in — continuing your request'); description = ''; label = '';
      break;
    case 'failed':
      title = t(state.reason === 'timeout' ? 'Sign-in timed out.'
        : state.reason === 'cancelled' ? 'Sign-in was cancelled.'
        : state.reason === 'connector_unavailable' ? "The OpenDesign sign-in component isn't available on this device."
        : state.reason === 'plan_open_failed' ? "Couldn't open your browser."
        : state.reason === 'continue_failed' ? (publish ? "Signed in, but couldn't publish again." : "Signed in, but couldn't continue your request.") : 'Sign-in failed.');
      description = state.reason === 'unknown' || state.reason === 'start_failed' || state.reason === 'continue_failed' ? state.message || '' : '';
      label = t('Retry'); action = retryAction;
      if (state.phase === 'upgrade' && state.reason === 'timeout') {
        title = t("We haven't detected your upgrade yet.");
        description = t("If you've already paid, click Check again; otherwise reopen the plans.");
        label = ''; plansAnchor = t('Reopen plans'); secondary = 'refresh';
      }
      if (state.reason === 'connector_unavailable') secondary = 'settings';
      break;
  }

  return (
    <div className="om-sa-action-card" data-kind={card.kind} data-state={state.status} role="group" aria-label={title}>
      <span className="om-sa-action-card-icon" aria-hidden="true">
        <RemixIcon name={state.status === 'done' || state.status === 'resuming' ? 'checkbox-circle-line' : publish ? 'global-line' : signIn ? 'account-circle-line' : 'sparkling-line'} size={18} />
      </span>
      <div className="om-sa-action-card-copy" aria-live="polite">
        <strong>{title}</strong>
        {description && <p id={descriptionId}>{description}</p>}
      </div>
      {label && (
        <Button
          variant="plain"
          type="button"
          className="om-sa-deliverable-btn om-sa-action-card-btn"
          data-primary
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
          onClick={action}
        >
          {label}
        </Button>
      )}
      {plansAnchor && pricingUrl && (
        <a
          className="om-sa-deliverable-btn om-sa-action-card-btn"
          data-primary
          href={pricingUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={description ? descriptionId : undefined}
          onClick={openPricing}
        >
          <span>{plansAnchor}</span>
          <RemixIcon name="external-link-line" size={14} />
        </a>
      )}
      {link && (
        <a className="om-sa-deliverable-btn om-sa-action-card-btn" href={link} target="_blank" rel="noreferrer">
          {t('Continue in browser')}
        </a>
      )}
      {secondary === 'cancel' && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => void cancel()}>
          {t('Cancel')}
        </Button>
      )}
      {secondary === 'refresh' && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => void refresh()}>
          {t(state.status === 'failed' ? 'Check again' : "I've upgraded")}
        </Button>
      )}
      {secondary === 'settings' && onOpenSettings && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => onOpenSettings(card, state.status === 'failed' ? 'account' : 'api_key')}>
          {t(state.status === 'failed' ? 'Open account settings' : 'Use my own API key')}
        </Button>
      )}
    </div>
  );
}
