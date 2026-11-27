// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attributedEntryId, currentProductId } from '../../../../shared/product-identity';
import { validProperties } from '../../../../tracking/core.ts';
import { studioEvents } from '../../../../tracking/events.ts';
import { I18nProvider } from '../../i18n/I18n';
import { campaignPricingUrl } from '../campaignAttribution';
import {
  closeMonetizationGate,
  detectMonetizationGateFromError,
  openBalanceGate,
  openConcurrencyGate,
  openMonetizationGate,
  readPreviewGateFromSearch,
} from './monetizationGateBus';
import { MonetizationGateModal } from './MonetizationGateModal';
import { trackMotion } from '../tracking';

vi.mock('../tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('../gatewayClient', () => ({
  gatewayRequest: vi.fn(async () => ({ state: 'signed-in', plan: 'free', balance: '0.00' })),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tracked = () => vi.mocked(trackMotion).mock.calls.map(([event, properties]) => ({
  event,
  properties: properties as Record<string, unknown>,
}));

describe('OpenGame monetization attribution & gate hooks', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.mocked(trackMotion).mockClear();
    closeMonetizationGate();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    closeMonetizationGate();
  });

  it('carries 4D od_* OpenGame attribution on checkout links without utm_* params while keeping raw click entry_id', () => {
    const id = '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11';
    const url = new URL(campaignPricingUrl('zh-CN', 'opengame_balance_gate', id, { studioId: 'motion', modality: 'video' }));
    expect(url.searchParams.get('od_entry_id')).toBe(attributedEntryId(id));
    expect(url.searchParams.get('od_origin')).toBe(currentProductId());
    expect(url.searchParams.get('od_entry_source')).toBe('balance_gate_topup');
    expect(url.searchParams.get('od_placement_id')).toBe('gui__studio__motion__video');
    expect(url.searchParams.has('utm_source')).toBe(false);
    expect(url.searchParams.has('utm_medium')).toBe(false);
    expect(url.searchParams.has('utm_campaign')).toBe(false);
  });

  it('matches gateway balance-too-low and concurrency errors without hardcoding studioId=game while ignoring 503 outages', () => {
    const balance402 = detectMonetizationGateFromError({ status: 402 });
    expect(balance402).toMatchObject({ kind: 'balance', reason: 'insufficient_balance' });
    expect(balance402?.studioId).toBeUndefined();

    const balanceCode = detectMonetizationGateFromError({ code: 'BALANCE_LOW' });
    expect(balanceCode).toMatchObject({ kind: 'balance', reason: 'insufficient_balance' });
    expect(balanceCode?.studioId).toBeUndefined();

    const balanceMsg = detectMonetizationGateFromError({ message: 'Your OpenDesign balance is too low for this request. Top up, then try again.' });
    expect(balanceMsg).toMatchObject({ kind: 'balance', reason: 'insufficient_balance' });
    expect(balanceMsg?.studioId).toBeUndefined();

    const quota = detectMonetizationGateFromError({ code: 'quota_exceeded' });
    expect(quota).toMatchObject({ kind: 'balance', reason: 'quota_exceeded' });
    expect(quota?.studioId).toBeUndefined();

    const concurrency = detectMonetizationGateFromError({ code: 'concurrency_limit' });
    expect(concurrency).toMatchObject({ kind: 'concurrency', reason: 'concurrency_limit' });
    expect(concurrency?.studioId).toBeUndefined();

    const videoConcurrency = detectMonetizationGateFromError({ code: 'video_concurrency_limit_exceeded' });
    expect(videoConcurrency).toMatchObject({ kind: 'concurrency', reason: 'concurrency_limit' });
    expect(videoConcurrency?.studioId).toBeUndefined();
    expect(detectMonetizationGateFromError({ status: 503, message: 'insufficient balance' })).toBeNull();
    expect(detectMonetizationGateFromError({ status: 502, message: 'Bad Gateway' })).toBeNull();
    expect(readPreviewGateFromSearch('?previewGate=balance')).toMatchObject({ kind: 'balance' });
    expect(readPreviewGateFromSearch('?previewGate=concurrency')).toMatchObject({ kind: 'concurrency' });
    expect(readPreviewGateFromSearch('?previewGate=resolution')).toMatchObject({ kind: 'resolution', resolutionLabel: '4K' });
    expect(readPreviewGateFromSearch('?mode=game')).toBeNull();
  });

  it('validates all active OpenGame monetization tracking events against the closed schema', () => {
    const id = '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11';
    for (const [event, props] of [
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'modal', hook_id: 'balance_gate_topup', entry_id: id, studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'open_pricing', hook_id: 'balance_gate_topup', entry_id: id, studio_id: 'game' }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_modal', element: 'check_balance', hook_id: 'concurrency_gate_upgrade', entry_id: id, studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_panel_signin', publish_target: 'game', studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_failed_signin', publish_target: 'game', studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_post_signin', publish_target: 'game', studio_id: 'game' }],
      ['surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_telegram_signin', publish_target: 'game', studio_id: 'game' }],
      ['surface_view', { page_name: 'model_hub', area: 'hub_header', element: 'banner', hook_id: 'model_hub_bf_pill', campaign_id: 'black_friday_2026', entry_id: id, hub_id: 'seedance-2-5', signed_in: false }],
      ['surface_view', { page_name: 'explore', area: 'campaign_banner', element: 'banner', hook_id: 'explore_bf_hero', campaign_id: 'black_friday_2026', entry_id: id }],
      ['surface_view', { page_name: 'settings', area: 'provider_detail', element: 'gate_card', hook_id: 'balance_gate_topup', signed_in: true }],
      ['ui_click', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'open_pricing', hook_id: 'game_publish_unlisted_upgrade', entry_id: id, publish_target: 'game', studio_id: 'game' }],
      ['ui_click', { page_name: 'explore', area: 'header', element: 'open_account' }],
      ['ui_click', { page_name: 'explore', area: 'header', element: 'open_subscription' }],
      ['ui_click', { page_name: 'explore', area: 'header', element: 'open_browser_signin', hook_id: 'header_signin' }],
      ['ui_click', { page_name: 'settings', area: 'provider_detail', element: 'get_api_key', provider_kind: 'builtin', provider_id: 'fal' }],
      ['ui_click', { page_name: 'creative_studio', area: 'web_publish', element: 'open_account_settings', publish_target: 'game', hook_id: 'game_publish_signin' }],
      ['ui_click', { page_name: 'studio', area: 'asset_create', element: 'connect_provider' }],
    ] as const) {
      expect(validProperties(studioEvents, event, props)).toBe(true);
    }
  });

  it('preserves caller entryId and hookId through MonetizationGateModal without re-minting', async () => {
    const callerEntryId = '11111111-2222-4333-8444-555555555555';
    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><MonetizationGateModal /></I18nProvider>);
    });
    await act(async () => {
      openBalanceGate({ reason: 'insufficient_balance', entryId: callerEntryId, hookId: 'failure_card_topup' });
    });

    const impression = tracked().find(item => item.event === 'surface_view');
    expect(impression?.properties).toMatchObject({
      hook_id: 'failure_card_topup',
      entry_id: callerEntryId,
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    expect(new URL(cta.href).searchParams.get('od_entry_id')).toBe(attributedEntryId(callerEntryId));

    await act(async () => {
      cta.click();
    });
    const click = tracked().find(item => item.event === 'ui_click' && item.properties.element === 'open_pricing');
    expect(click?.properties).toMatchObject({
      hook_id: 'failure_card_topup',
      entry_id: callerEntryId,
    });
  });

  it('renders BalanceGateDialog, tracks impression & CTA click, and deduplicates focus+visibilitychange refresh', async () => {
    await act(async () => {
      root.render(<I18nProvider initialLocale="zh-CN"><MonetizationGateModal /></I18nProvider>);
    });
    expect(document.querySelector('[data-testid="balance-gate-dialog"]')).toBeNull();

    await act(async () => {
      openBalanceGate({ reason: 'insufficient_balance' });
    });

    const dialog = document.querySelector('[data-testid="balance-gate-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('需要补充额度以继续');

    const impression = tracked().find(item => item.event === 'surface_view');
    expect(impression?.properties).toMatchObject({
      page_name: 'creative_studio',
      area: 'entitlement_modal',
      element: 'modal',
      hook_id: 'balance_gate_topup',
      studio_id: 'game',
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    const url = new URL(cta.href);
    expect(url.searchParams.get('od_entry_id')).toBe(attributedEntryId(String(impression!.properties.entry_id)));

    await act(async () => {
      cta.click();
    });
    expect(document.querySelector('[data-testid="monetization-gate-polling"]')).not.toBeNull();

    // Simultaneous focus + visibilitychange should emit only one entitlement_refresh_result.
    vi.mocked(trackMotion).mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    const refreshes = tracked().filter(item => item.event === 'entitlement_refresh_result');
    expect(refreshes.length).toBe(1);
  });

  it('renders ConcurrencyGateDialog with counts and tracks dismiss', async () => {
    await act(async () => {
      root.render(<I18nProvider initialLocale="zh-CN"><MonetizationGateModal /></I18nProvider>);
      openConcurrencyGate({ activeCount: 2, limitCount: 2 });
    });

    const dialog = document.querySelector('[data-testid="concurrency-gate-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('2/2');

    const closeBtn = dialog!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
      ?? dialog!.querySelector<HTMLButtonElement>('.om-mg-close')!;
    await act(async () => {
      closeBtn.click();
    });
    expect(document.querySelector('[data-testid="concurrency-gate-dialog"]')).toBeNull();
    expect(tracked().some(item => item.event === 'ui_click' && item.properties.element === 'close_modal' && item.properties.hook_id === 'concurrency_gate_upgrade')).toBe(true);
  });

  it('invokes onRecovered once when balance increases after checkout check', async () => {
    const { gatewayRequest } = await import('../gatewayClient');
    const mockGateway = vi.mocked(gatewayRequest);
    mockGateway
      .mockResolvedValueOnce({ state: 'signed-in', plan: 'plus', balance: '0.00', billingUnavailable: false })
      .mockResolvedValueOnce({ state: 'signed-in', plan: 'plus', balance: '10.00', billingUnavailable: false });

    const onRecovered = vi.fn();
    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><MonetizationGateModal /></I18nProvider>);
    });
    await act(async () => {
      openBalanceGate({ reason: 'insufficient_balance', onRecovered });
      await Promise.resolve();
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    await act(async () => {
      cta.click();
    });

    const checkBtn = document.querySelector<HTMLButtonElement>('.om-mg-inline-btn')!;
    expect(checkBtn).not.toBeNull();
    await act(async () => {
      checkBtn.click();
      await Promise.resolve();
    });

    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="monetization-gate-recovered"]')).not.toBeNull();
  });

  it('surfaces a failed onRecovered auto-resume with an alert and Retry action instead of silently closing', async () => {
    const { gatewayRequest } = await import('../gatewayClient');
    const mockGateway = vi.mocked(gatewayRequest);
    mockGateway
      .mockResolvedValueOnce({ state: 'signed-in', plan: 'plus', balance: '0.00', billingUnavailable: false })
      .mockResolvedValueOnce({ state: 'signed-in', plan: 'plus', balance: '10.00', billingUnavailable: false });

    const onRecovered = vi.fn()
      .mockRejectedValueOnce(new Error('Could not continue the conversation. Try again.'))
      .mockResolvedValueOnce(undefined);

    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><MonetizationGateModal /></I18nProvider>);
    });
    await act(async () => {
      openBalanceGate({ reason: 'insufficient_balance', onRecovered });
      await Promise.resolve();
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    await act(async () => {
      cta.click();
    });

    const checkBtn = document.querySelector<HTMLButtonElement>('.om-mg-inline-btn')!;
    await act(async () => {
      checkBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRecovered).toHaveBeenCalledTimes(1);
    const errorBanner = document.querySelector('[data-testid="monetization-gate-resume-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain('Could not continue the conversation. Try again.');
    expect(document.querySelector('[data-testid="balance-gate-dialog"]')).not.toBeNull();

    // Clicking Try again retries onRecovered and clears the error banner
    const retryBtn = errorBanner!.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });
    expect(onRecovered).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="monetization-gate-resume-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="monetization-gate-recovered"]')).not.toBeNull();
  });

  it('suppresses motion:account-changed when shared post-checkout entitlement refresh fails', async () => {
    const { gatewayRequest } = await import('../gatewayClient');
    const { refreshEntitlementAfterCheckout } = await import('../entitlementAttribution');
    const mockGateway = vi.mocked(gatewayRequest);
    mockGateway.mockResolvedValueOnce({ state: 'signed-in', plan: 'free', billingUnavailable: true });

    const accountChanged = vi.fn();
    window.addEventListener('motion:account-changed', accountChanged);
    try {
      await refreshEntitlementAfterCheckout('creative_studio', 'studio_free_gate', '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11', Promise.resolve('free'));
      expect(accountChanged).not.toHaveBeenCalled();
      expect(tracked().filter(item => item.event === 'entitlement_refresh_result')).toEqual([
        {
          event: 'entitlement_refresh_result',
          properties: {
            page_name: 'creative_studio',
            hook_id: 'studio_free_gate',
            entry_id: '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11',
            outcome: 'failure',
            plan_changed: false,
          },
        },
      ]);
    } finally {
      window.removeEventListener('motion:account-changed', accountChanged);
    }
  });

  it('propagates caller studioId, modality, and entryId across modal view, click, refresh, and pricing URL', async () => {
    const seededEntryId = '11111111-2222-4333-8444-555555555555';
    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><MonetizationGateModal /></I18nProvider>);
      openMonetizationGate({
        kind: 'balance',
        pageName: 'studio',
        studioId: 'motion',
        modality: 'video',
        entryId: seededEntryId,
      });
    });

    const impression = tracked().find(item => item.event === 'surface_view');
    expect(impression?.properties).toMatchObject({
      page_name: 'studio',
      area: 'entitlement_modal',
      element: 'modal',
      hook_id: 'balance_gate_topup',
      studio_id: 'motion',
      modality: 'video',
      entry_id: seededEntryId,
    });

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="monetization-gate-cta"]')!;
    cta.addEventListener('click', event => event.preventDefault());
    const url = new URL(cta.href);
    expect(url.searchParams.get('od_origin')).toBe(currentProductId());
    expect(url.searchParams.get('od_entry_source')).toBe('balance_gate_topup');
    expect(url.searchParams.get('od_entry_id')).toBe(attributedEntryId(seededEntryId));
    expect(url.searchParams.get('od_placement_id')).toBe('gui__studio__motion__video');
    expect(url.searchParams.has('utm_source')).toBe(false);

    await act(async () => { cta.click(); });
    expect(tracked().find(item => item.event === 'ui_click' && item.properties.element === 'open_pricing')?.properties).toMatchObject({
      page_name: 'studio',
      studio_id: 'motion',
      modality: 'video',
      entry_id: seededEntryId,
    });

    vi.mocked(trackMotion).mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(tracked().find(item => item.event === 'entitlement_refresh_result')?.properties).toMatchObject({
      page_name: 'studio',
      hook_id: 'balance_gate_topup',
      entry_id: seededEntryId,
      studio_id: 'motion',
      modality: 'video',
    });
  });
});
