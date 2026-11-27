// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationJob, Model } from '../../../../shared/gateway';
import { currentProductId } from '../../../../shared/product-identity';
import { findMediaStudio } from '../../../../shared/studio-catalog';
import { I18nProvider } from '../../i18n/I18n';
import { AssetComposer, type AssetDraft } from '../AssetComposer';
import { studioDestination } from '../creativeStudios';
import { MediaGenerator } from '../MediaGenerator';
import {
  closeMonetizationGate,
  getMonetizationGateSnapshot,
} from './monetizationGateBus';

const mocks = vi.hoisted(() => ({
  assetRequest: vi.fn(),
  loadGateway: vi.fn(),
  gatewayRequest: vi.fn(),
  generateAsset: vi.fn(),
  trackMotion: vi.fn(async () => 'queued'),
  chrome: {
    openModelSettings: vi.fn(),
    openProviderSettings: vi.fn(),
    openAccountSettings: vi.fn(),
    openSubscriptionSettings: vi.fn(),
  },
}));

vi.mock('../assetClient', () => ({ assetRequest: mocks.assetRequest }));
vi.mock('../gatewayClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../gatewayClient')>();
  return {
    ...actual,
    loadGateway: mocks.loadGateway,
    gatewayRequest: mocks.gatewayRequest,
    generateAsset: mocks.generateAsset,
    invalidateGatewayCache: vi.fn(),
  };
});
vi.mock('../AssetConversation', () => ({ AssetConversation: () => null }));
vi.mock('../WorkspaceFrame', () => ({ useWorkspaceChrome: () => mocks.chrome }));
vi.mock('../tracking', () => ({ trackMotion: mocks.trackMotion }));
vi.mock('../ArtifactViewState', () => ({ useArtifactViewActive: () => true }));
vi.mock('../useMediaPopoverPosition', () => ({ useMediaPopoverPosition: () => ({ ref: { current: null }, style: {} }) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Scene-isolated monetization gate attribution (Motion, Assets, Design) and tracking_context header', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    closeMonetizationGate();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    closeMonetizationGate();
  });

  it('MediaGenerator passes studioId=motion and modality on submit balance error and failure_card_topup click', async () => {
    const videoModel: Model = {
      id: 'account:kling',
      provider: 'account',
      modelId: 'kling',
      label: 'Kling Video',
      modality: 'video',
      source: 'live',
      mode: 'text-to-video',
    };
    const failedJob: GenerationJob = {
      id: 'job-motion-fail-1',
      state: 'failed',
      phase: 'submitting',
      projectId: 'proj-motion-1',
      modality: 'video',
      prompt: 'neon city intro',
      model: videoModel,
      errorCode: 'BALANCE_LOW',
      error: 'Your OpenDesign balance is too low for this request. Top up, then try again.',
      assets: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mocks.loadGateway.mockResolvedValue({
      models: [videoModel],
      status: {
        providers: [{ id: 'account', label: 'OpenDesign', available: true, configured: true }],
        routes: { video: videoModel.id },
      },
    });
    mocks.gatewayRequest.mockImplementation(async (route: string) => {
      if (route.startsWith('project/status')) return { projectId: 'proj-motion-1' };
      if (route.startsWith('generations')) return { jobs: [failedJob] };
      return {};
    });
    mocks.generateAsset.mockRejectedValue(new Error('Your OpenDesign balance is too low for this request. Top up, then try again.'));

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <MediaGenerator
            request={{ modality: 'video', prompt: 'neon city intro', target: { projectId: 'proj-motion-1' } }}
            onClose={() => {}}
            onSettings={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    // 1. Submit error opens balance gate with studioId='motion' and modality='video' (never 'game').
    const submitBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.includes('Generate'))!;
    await act(async () => { submitBtn.click(); });
    expect(getMonetizationGateSnapshot()).toMatchObject({
      kind: 'balance',
      pageName: 'studio',
      studioId: 'motion',
      modality: 'video',
    });

    // 2. Clicking failure_card_topup emits entry_id + studio_id='motion' + modality='video' and shares entryId with the gate.
    closeMonetizationGate();
    mocks.trackMotion.mockClear();
    const topupBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.includes('Top up or upgrade'))!;
    await act(async () => { topupBtn.click(); });

    const clickCall = mocks.trackMotion.mock.calls.find(([event, props]) => event === 'ui_click' && (props as Record<string, unknown>).hook_id === 'failure_card_topup');
    expect(clickCall).toBeTruthy();
    const clickProps = clickCall![1] as Record<string, unknown>;
    expect(clickProps).toMatchObject({
      page_name: 'studio',
      area: 'entitlement_gate',
      element: 'open_pricing',
      hook_id: 'failure_card_topup',
      studio_id: 'motion',
      modality: 'video',
    });
    expect(String(clickProps.entry_id)).toMatch(UUID_RE);
    expect(getMonetizationGateSnapshot()).toMatchObject({
      kind: 'balance',
      pageName: 'studio',
      studioId: 'motion',
      modality: 'video',
      entryId: clickProps.entry_id,
    });
  });

  it('AssetComposer attributes standalone Assets to studioId=assets (never game) and studio-hosted composers to their studioId + modality', async () => {
    const audioModel: Model = {
      id: 'account:music',
      provider: 'account',
      modelId: 'music',
      label: 'Account Music',
      modality: 'audio',
      source: 'live',
      mode: 'text-to-audio',
    };
    mocks.loadGateway.mockResolvedValue({
      models: [audioModel],
      status: {
        providers: [{ id: 'account', label: 'OpenDesign', available: true, configured: true }],
        routes: {},
      },
    });
    mocks.assetRequest.mockRejectedValue(Object.assign(new Error('Insufficient balance'), { status: 402 }));

    const baseDraft: AssetDraft = {
      modality: 'audio',
      model: audioModel.id,
      prompt: 'ambient synth pad',
      parameters: {},
      references: [],
    };
    const commonProps = {
      active: true,
      draft: baseDraft,
      setDraft: vi.fn(),
      agentReferences: [],
      setAgentReferences: vi.fn(),
      jobs: [],
      mode: 'direct' as const,
      onMode: vi.fn(),
      taskIds: {},
      history: { tasks: [], loading: false, onRetry: vi.fn(), onSelect: vi.fn() },
      selectingTask: false,
      onNew: vi.fn(),
      onChatChanged: vi.fn(),
      onChatStarted: vi.fn(),
      onCancel: vi.fn(),
      onView: vi.fn(),
      onReference: vi.fn(),
      onCreated: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    };

    // 1. Standalone Assets (no studio prop) -> studioId='assets', modality='audio'
    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><AssetComposer {...commonProps} /></I18nProvider>);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
    expect(getMonetizationGateSnapshot()).toMatchObject({
      kind: 'balance',
      pageName: 'assets',
      studioId: 'assets',
      modality: 'audio',
    });

    // 2. Free plan gate link in standalone Assets carries 4D od_* without utm_*
    closeMonetizationGate();
    mocks.loadGateway.mockResolvedValue({
      models: [audioModel],
      status: {
        providers: [{ id: 'account', label: 'OpenDesign', available: true, configured: true, plan: 'free', mediaEntitlement: 'not-included' }],
        routes: {},
      },
    });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><AssetComposer {...commonProps} /></I18nProvider>);
    });
    const upgradeLink = container.querySelector<HTMLAnchorElement>('a[href*="pricing"]')!;
    expect(upgradeLink).not.toBeNull();
    const upgradeUrl = new URL(upgradeLink.href);
    expect(upgradeUrl.searchParams.get('od_origin')).toBe(currentProductId());
    expect(upgradeUrl.searchParams.get('od_entry_source')).toBe('studio_free_gate');
    expect(upgradeUrl.searchParams.get('od_placement_id')).toBe('gui__studio__assets__audio');
    expect(upgradeUrl.searchParams.has('utm_source')).toBe(false);

    // 3. Studio-hosted composer (Sound studio) -> studioId='sound', modality='audio'
    const soundStudio = findMediaStudio('sound')!;
    mocks.loadGateway.mockResolvedValue({
      models: [audioModel],
      status: {
        providers: [{ id: 'account', label: 'OpenDesign', available: true, configured: true }],
        routes: {},
      },
    });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <AssetComposer
            {...commonProps}
            studio={{
              catalog: { catalog: { models: [audioModel], status: { providers: [{ id: 'account', label: 'OpenDesign', available: true, configured: true }], routes: {} } } as any, failed: false, retry: vi.fn() },
              destination: studioDestination(soundStudio, 'music', audioModel.id),
              remember: vi.fn(),
              chooseModel: vi.fn(),
            } as any}
          />
        </I18nProvider>,
      );
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
    expect(getMonetizationGateSnapshot()).toMatchObject({
      kind: 'balance',
      pageName: 'creative_studio',
      studioId: 'sound',
      modality: 'audio',
    });
  });

  it('gatewayRequest forwards valid ?tracking_context UUID as X-Tracking-Context header and omits invalid values', async () => {
    const actualClient = await vi.importActual<typeof import('../gatewayClient')>('../gatewayClient');
    const fetchSpy = vi.fn(async () => Response.json({ state: 'signed-out' }));
    vi.stubGlobal('fetch', fetchSpy);
    const originalUrl = window.location.href;
    try {
      const token = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
      window.history.replaceState(null, '', `/settings/providers?provider=account&tracking_context=${token}`);
      await actualClient.gatewayRequest('settings/account/login', 'POST', { hookId: 'settings_signin' });
      const firstInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((firstInit.headers as Record<string, string>)['X-Tracking-Context']).toBe(token);

      fetchSpy.mockClear();
      window.history.replaceState(null, '', '/settings/providers?tracking_context=not-a-uuid');
      await actualClient.gatewayRequest('settings/account/login', 'POST', { hookId: 'settings_signin' });
      const secondInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((secondInit.headers as Record<string, string>)['X-Tracking-Context']).toBeUndefined();
    } finally {
      window.history.replaceState(null, '', originalUrl);
      vi.unstubAllGlobals();
    }
  });

  it('switches GUI od_origin and od_entry_id prefix dynamically from window.__OM_SOURCE_PRODUCT__ without rebuilding', async () => {
    const { campaignPricingUrl } = await import('../campaignAttribution');
    const win = window as unknown as { __OM_SOURCE_PRODUCT__?: string };
    const previous = win.__OM_SOURCE_PRODUCT__;
    const entryId = '22222222-3333-4444-8555-666666666666';
    try {
      win.__OM_SOURCE_PRODUCT__ = 'openmotion';
      const motionUrl = new URL(campaignPricingUrl('en', 'opengame_balance_gate', entryId, { studioId: 'motion', modality: 'video', campaign: false }));
      expect(motionUrl.searchParams.get('od_origin')).toBe('openmotion');
      expect(motionUrl.searchParams.get('od_entry_id')).toBe(entryId);

      win.__OM_SOURCE_PRODUCT__ = 'opengame';
      const gameUrl = new URL(campaignPricingUrl('en', 'opengame_balance_gate', entryId, { studioId: 'game', modality: 'image', campaign: false }));
      expect(gameUrl.searchParams.get('od_origin')).toBe('opengame');
      expect(gameUrl.searchParams.get('od_entry_id')).toBe(`opengame-${entryId}`);
    } finally {
      if (previous === undefined) delete win.__OM_SOURCE_PRODUCT__;
      else win.__OM_SOURCE_PRODUCT__ = previous;
    }
  });
});
