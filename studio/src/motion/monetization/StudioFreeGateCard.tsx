import { useEffect, useRef, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import {
  BLACK_FRIDAY_CAMPAIGN,
  campaignPricingUrl,
  newCampaignEntryId,
  pricingLinkTargetProps,
  useBlackFridayActive,
} from '../campaignAttribution';
import { setPendingAttribution, useCheckoutReturnRefresh } from '../entitlementAttribution';
import * as tracking from '../pageTracking';
import { send } from '../reporting';

export interface StudioFreeGateCardProps {
  pageName: 'creative_studio' | 'assets';
  studioId?: string;
  modality?: tracking.AttributionModality;
  testId?: string;
  iconSize?: number;
  onManageSubscription: () => void;
}

/**
 * Shared inline upgrade gate rendered when a signed-in account's current plan does not include multimodal generation.
 * Owns the deduped `studio_free_gate` impression, direct Pricing upgrade link + checkout-return refresh,
 * and pending-attribution handoff for "Manage subscription".
 */
export function StudioFreeGateCard({
  pageName,
  studioId,
  modality,
  testId = 'studio-free-gate',
  iconSize = 20,
  onManageSubscription,
}: StudioFreeGateCardProps) {
  const { locale, t } = useI18n();
  const campaign = useBlackFridayActive();
  const [entryId, setEntryId] = useState(newCampaignEntryId);
  const effectiveStudioId = studioId ?? (pageName === 'assets' ? 'assets' : 'unknown');
  const markCheckoutReturn = useCheckoutReturnRefresh(pageName, 'studio_free_gate', {
    studioId: effectiveStudioId,
    ...(modality ? { modality } : {}),
  });
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    tracking.reportEntitlementGateView(pageName, 'studio_free_gate', {
      studio_id: effectiveStudioId,
      ...(modality ? { modality } : {}),
      entry_id: entryId,
      ...(campaign ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } : {}),
    });
  }, [pageName, effectiveStudioId, modality, entryId, campaign]);

  return (
    <div className="om-creation-setup" role="status" data-testid={testId}>
      <RemixIcon name="bank-card-line" size={iconSize} />
      <p className="om-muted">{t('Signed in; multimodal generation requires OpenDesign Plus or above')}</p>
      <div className="om-control-row">
        <a
          className="om-button"
          data-primary
          href={campaignPricingUrl(locale, 'opengame_studio_free_gate', entryId, {
            studioId: effectiveStudioId,
            modality: modality ?? 'all',
          })}
          {...pricingLinkTargetProps()}
          onClick={() => {
            const clickedId = entryId;
            markCheckoutReturn(clickedId);
            send('ui_click', {
              page_name: pageName,
              area: 'asset_create',
              element: 'open_pricing',
              hook_id: 'studio_free_gate',
              entry_id: clickedId,
              ...(campaign ? { campaign_id: BLACK_FRIDAY_CAMPAIGN } : {}),
              studio_id: effectiveStudioId,
              ...(modality ? { modality } : {}),
            });
            window.setTimeout(() => setEntryId(newCampaignEntryId()), 0);
          }}
        >
          <RemixIcon name="sparkling-line" size={15} />
          {campaign ? t('Upgrade · 50% OFF') : t('Upgrade to Plus')}
          <RemixIcon name="external-link-line" size={14} />
        </a>
        <Button
          type="button"
          variant="ghost"
          className="om-button h-auto"
          onClick={() => {
            const manageEntryId = tracking.newTrackingId();
            setPendingAttribution('subscription', 'studio_free_gate', manageEntryId, {
              studioId: effectiveStudioId,
              ...(modality ? { modality } : {}),
            });
            send('ui_click', {
              page_name: pageName,
              area: 'asset_create',
              element: 'manage_subscription',
              hook_id: 'studio_free_gate',
              entry_id: manageEntryId,
              studio_id: effectiveStudioId,
              ...(modality ? { modality } : {}),
            });
            onManageSubscription();
          }}
        >
          {t('Manage subscription')}
        </Button>
      </div>
    </div>
  );
}
