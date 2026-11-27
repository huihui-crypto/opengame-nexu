// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '../../../shared/provider-directory';
import { currentProductId } from '../../../shared/product-identity';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import { gatewayRequest } from '../motion/gatewayClient';
import { reportEntitlementGateClick, reportEntitlementGateView, reportEntitlementRefresh } from '../motion/pageTracking';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { AccountHandoffCard } from './AccountHandoffCard';
import { resetAccountHandoffSessions } from './useAccountHandoff';

vi.mock('../motion/gatewayClient', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../motion/useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
vi.mock('../motion/pageTracking', () => ({ newTrackingId: () => crypto.randomUUID(), reportEntitlementGateView: vi.fn(), reportEntitlementGateClick: vi.fn(), reportEntitlementRefresh: vi.fn() }));
let blackFriday = false;
vi.mock('../motion/campaignAttribution', async importOriginal => ({
  ...(await importOriginal<typeof import('../motion/campaignAttribution')>()),
  useBlackFridayActive: () => blackFriday,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: SuperAgentActionCard = { id: 'signin', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' };
let root: Root;
let container: HTMLDivElement;
let account: AccountSummary;
let loginResult: AccountSummary;
const onResume = vi.fn();
const onOpenSettings = vi.fn();
const request = vi.mocked(gatewayRequest);
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
const status = () => container.querySelector('.om-sa-action-card')?.getAttribute('data-state');
const click = async (label: string) => { expect(button(label), label).toBeTruthy(); await act(async () => button(label).click()); };
const plansLink = (label: string) => Array.from(container.querySelectorAll('a')).find(item => item.textContent === label)!;
const entryIdOf = (href: string | null) => new URL(href ?? '').searchParams.get('od_entry_id');
const openPlansLink = async (label: string) => {
  expect(plansLink(label), label).toBeTruthy();
  await act(async () => plansLink(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  resetAccountHandoffSessions();
  vi.useFakeTimers();
  vi.clearAllMocks();
  blackFriday = false;
  vi.spyOn(window, 'open').mockReturnValue(null);
  // Anchors navigate on click in happy-dom; the card only needs the click to start its upgrade wait.
  document.addEventListener('click', preventNavigation, true);
  account = { state: 'signed-out', consoleUrl: '' };
  loginResult = { state: 'authorizing', consoleUrl: '', authorizationUrl: 'https://example.test/login', userCode: 'ABCD', browserOpened: true };
  onResume.mockReset();
  request.mockReset().mockImplementation(async path => {
    if (path === 'settings/account/login') { account = loginResult; return account; }
    if (path === 'settings/account/cancel') { account = { state: 'signed-out', consoleUrl: '' }; return account; }
    return account;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
function preventNavigation(event: Event) { if ((event.target as Element | null)?.closest?.('a')) event.preventDefault(); }
afterEach(async () => {
  document.removeEventListener('click', preventNavigation, true);
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function render(target = card, strict = false, handoffKey?: string) {
  await act(async () => {
    const content = <I18nProvider initialLocale="en"><AccountHandoffCard card={target} handoffKey={handoffKey} onResume={onResume} onOpenSettings={onOpenSettings} /></I18nProvider>;
    root.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
}

describe('AccountHandoffCard', () => {
  it('starts attributed sign-in, shows browser details, and resumes Plus exactly once', async () => {
    await render();
    await click('Sign in & continue');
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'studio_generate', entryId: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i) });
    expect(container.textContent).toContain('Verification code: ABCD');
    expect(container.querySelector('a')?.textContent).toBe('Continue in browser');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(loginResult.authorizationUrl);
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: 'plus', key: card.id });
    expect(notifyProvidersChanged).toHaveBeenCalledTimes(1);
    expect(status()).toBe('done');
    expect(container.querySelector('button')).toBeNull();
    await tick(10_000);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await render({ ...card });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it.each(['free', 'go'])('offers the attributed pricing link after %s sign-in and resumes on refresh', async plan => {
    await render();
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', plan };
    await tick(2_000);
    const login = request.mock.calls.find(call => call[0] === 'settings/account/login')!;
    const loginEntry = (login[2] as { entryId: string }).entryId;
    expect(status()).toBe('opening_plan');
    const href = plansLink('Upgrade to Plus').getAttribute('href');
    expect(href).toContain('open-design.ai/');
    const parsedHref = new URL(href!);
    expect(parsedHref.searchParams.get('od_origin')).toBe(currentProductId());
    expect(parsedHref.searchParams.get('od_entry_source')).toBe('studio_free_gate');
    expect(parsedHref.searchParams.get('od_placement_id')).toBe('gui__studio__game__all');
    expect(parsedHref.searchParams.has('utm_medium')).toBe(false);
    expect(parsedHref.searchParams.has('utm_source')).toBe(false);
    expect(entryIdOf(href)).toContain(loginEntry);
    expect(request.mock.calls.some(call => call[0] === 'settings/account/subscription')).toBe(false);
    await openPlansLink('Upgrade to Plus');
    expect(reportEntitlementGateClick).toHaveBeenLastCalledWith('creative_studio', 'open_pricing', 'studio_generate', { studio_id: 'game', entry_id: loginEntry });
    expect(status()).toBe('awaiting_upgrade');
    expect(onResume).not.toHaveBeenCalled();
    account = { ...account, plan: 'plus' };
    await click("I've upgraded");
    expect(request).toHaveBeenCalledWith('settings/account?refresh=true');
    expect(reportEntitlementRefresh).toHaveBeenCalledWith('creative_studio', 'studio_generate', loginEntry, 'success', true);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: 'plus', key: card.id });
  });
  it.each(['upgrade_free', 'upgrade_go'] as const)('opens the pricing link directly for a signed-in %s account without signing in', async kind => {
    const target = { ...card, kind };
    account = { state: 'signed-in', plan: kind === 'upgrade_go' ? 'go' : 'free', consoleUrl: '' };
    await render(target);
    expect(reportEntitlementGateView).toHaveBeenCalledWith('creative_studio', 'studio_free_gate', { studio_id: 'game', entry_id: expect.any(String) });
    await click('Use my own API key');
    expect(onOpenSettings).toHaveBeenCalledWith(target, 'api_key');
    await openPlansLink('Upgrade to Plus');
    expect(status()).toBe('awaiting_upgrade');
    expect(request).not.toHaveBeenCalledWith('settings/account/login', expect.anything(), expect.anything());
    expect(request.mock.calls.some(call => call[0] === 'settings/account/subscription')).toBe(false);
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(5_000);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('labels the pricing link with the Black Friday offer and attributes the campaign', async () => {
    blackFriday = true;
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render({ ...card, kind: 'upgrade_free' });
    await openPlansLink('Upgrade · 50% OFF');
    expect(reportEntitlementGateClick).toHaveBeenLastCalledWith('creative_studio', 'open_pricing', 'studio_free_gate', { studio_id: 'game', entry_id: expect.any(String), campaign_id: 'black_friday_2026' });
    expect(status()).toBe('awaiting_upgrade');
  });
  it('signs a signed-out upgrade card in locally before offering plans', async () => {
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'studio_free_gate', entryId: expect.any(String) });
    expect(status()).toBe('authorizing');
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await tick(2_000);
    expect(status()).toBe('opening_plan');
    expect(plansLink('Upgrade to Plus')).toBeTruthy();
    expect(onResume).not.toHaveBeenCalled();
  });
  it('rereads billing when sign-in completes before the plan is known', async () => {
    await render();
    await click('Sign in & continue');
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => args[0] === 'settings/account?refresh=true'
      ? { state: 'signed-in', plan: 'go', consoleUrl: '' } : original(...args));
    account = { state: 'signed-in', consoleUrl: '' };
    await tick(2_000);
    expect(request).toHaveBeenCalledWith('settings/account?refresh=true');
    expect(status()).toBe('opening_plan');
    expect(onResume).not.toHaveBeenCalled();
  });
  it('keeps waiting for sign-in after the card unmounts and remounts (preview expanded)', async () => {
    await render();
    await click('Sign in & continue');
    expect(status()).toBe('authorizing');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(status()).toBe('authorizing');
    expect(container.textContent).toContain('Verification code');
    account = { state: 'signed-in', plan: 'plus', consoleUrl: '' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(call => call[0] === 'settings/account/login')).toHaveLength(1);
  });
  it('resumes a later card with the same gateway id in another turn or chat', async () => {
    account = { state: 'signed-in', plan: 'plus', consoleUrl: '' };
    await render(card, false, 'chat-a:turn-1:signin');
    await click('Continue');
    expect(onResume).toHaveBeenLastCalledWith(card, { plan: 'plus', key: 'chat-a:turn-1:signin' });
    await render(card, false, 'chat-b:turn-1:signin');
    await click('Continue');
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenLastCalledWith(card, { plan: 'plus', key: 'chat-b:turn-1:signin' });
    expect(status()).toBe('done');
  });
  it('keeps the plans CTA and its entry id after the card remounts', async () => {
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render();
    await click('Sign in & continue');
    expect(status()).toBe('opening_plan');
    const before = plansLink('Upgrade to Plus').getAttribute('href');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(status()).toBe('opening_plan');
    expect(entryIdOf(plansLink('Upgrade to Plus').getAttribute('href'))).toBe(entryIdOf(before));
    await openPlansLink('Upgrade to Plus');
    expect(status()).toBe('awaiting_upgrade');
  });
  it('continues an unfinished start step after the card remounts', async () => {
    const original = request.getMockImplementation()!;
    let firstRead!: (value: AccountSummary) => void;
    let held = true;
    request.mockImplementation((...args) => held && args[0] === 'settings/account' && request.mock.calls.filter(call => call[0] === 'settings/account').length === 2
      ? new Promise<AccountSummary>(resolve => { firstRead = resolve; }) : original(...args));
    await render();
    await click('Sign in & continue');
    expect(status()).toBe('starting');
    held = false;
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'studio_generate', entryId: expect.any(String) });
    expect(status()).toBe('authorizing');
    await act(async () => firstRead({ state: 'signed-out', consoleUrl: '' }));
    expect(status()).toBe('authorizing');
  });
  it('keeps a continuation that is still in flight when the card remounts, and surfaces its failure', async () => {
    let failResume!: (error: Error) => void;
    onResume.mockImplementationOnce(() => new Promise((_, reject) => { failResume = reject; })).mockResolvedValueOnce(undefined);
    await render();
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click('Continue');
    expect(status()).toBe('resuming');
    expect(onResume).toHaveBeenCalledTimes(1);
    await act(async () => failResume(new Error('Temporary send failure')));
    expect(status()).toBe('failed');
    expect(container.textContent).toContain("Signed in, but couldn't continue your request.");
    await click('Retry');
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(status()).toBe('done');
  });
  it('reports the upgrade under the entry id of the pricing link actually opened, across remounts', async () => {
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render({ ...card, kind: 'upgrade_free' });
    const opened = entryIdOf(plansLink('Upgrade to Plus').getAttribute('href'))!;
    await openPlansLink('Upgrade to Plus');
    await tick(20 * 60_000);
    expect(entryIdOf(plansLink('Reopen plans').getAttribute('href'))).not.toBe(opened);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ ...card, kind: 'upgrade_free' });
    account = { ...account, plan: 'plus' };
    await click('Check again');
    const [, , reported] = vi.mocked(reportEntitlementRefresh).mock.lastCall!;
    expect(opened).toContain(reported!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('times out sign-in, cancels the connector, and permits retry', async () => {
    await render();
    await click('Sign in & continue');
    await tick(5 * 60_000);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain('Sign-in timed out.');
    expect(request).toHaveBeenCalledWith('settings/account/cancel', 'POST');
    await click('Retry');
    expect(status()).toBe('authorizing');
    expect(onResume).not.toHaveBeenCalled();
  });
  it('checks for payment after checkout times out without cancelling or reopening plans', async () => {
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render({ ...card, kind: 'upgrade_free' });
    await openPlansLink('Upgrade to Plus');
    await tick(20 * 60_000);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain("We haven't detected your upgrade yet.");
    expect(container.textContent).toContain("If you've already paid, click Check again; otherwise reopen the plans.");
    expect(plansLink('Reopen plans')).toBeTruthy();
    expect(button('Check again')).toBeTruthy();
    expect(container.textContent).not.toContain('Sign-in timed out.');
    expect(request).not.toHaveBeenCalledWith('settings/account/cancel', 'POST');
    const calls = request.mock.calls.length;
    await click('Check again');
    expect(request.mock.calls.slice(calls)).toEqual([['settings/account?refresh=true']]);
    expect(status()).toBe('failed');
    expect(onResume).not.toHaveBeenCalled();
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await click('Check again');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(status()).toBe('done');
  });
  it.each(['sign_in', 'upgrade_free'] as const)('reopens attributed plans with a new entry id after an upgrade timeout on a %s card', async kind => {
    account = { ...account, state: 'signed-in', plan: 'free' };
    await render({ ...card, kind });
    if (kind === 'sign_in') await click('Sign in & continue');
    const first = entryIdOf(plansLink('Upgrade to Plus').getAttribute('href'));
    await openPlansLink('Upgrade to Plus');
    await tick(20 * 60_000);
    const second = entryIdOf(plansLink('Reopen plans').getAttribute('href'));
    expect(second).not.toBe(first);
    await openPlansLink('Reopen plans');
    expect(status()).toBe('awaiting_upgrade');
    const tracked = vi.mocked(reportEntitlementGateClick).mock.lastCall!;
    expect(tracked.slice(0, 3)).toEqual(['creative_studio', 'open_pricing', kind === 'sign_in' ? 'studio_generate' : 'studio_free_gate']);
    // The click is tracked with the same entry_id the reopened pricing link carries.
    expect(second).toContain(tracked[3]!.entry_id);
  });
  it.each(['sign_in', 'upgrade_free', 'upgrade_go'] as const)('retries a rejected continuation from a %s card', async kind => {
    onResume.mockRejectedValueOnce(new Error('Could not continue the conversation. Try again.')).mockResolvedValueOnce(undefined);
    const target = { ...card, kind };
    await render(target);
    await click(kind === 'sign_in' ? 'Sign in & continue' : 'Upgrade to Plus');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain('Could not continue the conversation. Try again.');
    // The user did sign in; only the follow-up send failed, so the card must not claim sign-in failed.
    expect(container.textContent).toContain("Signed in, but couldn't continue your request.");
    expect(container.textContent).not.toContain('Sign-in failed.');
    await click('Retry');
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenLastCalledWith(target, { plan: 'plus', key: target.id });
    expect(status()).toBe('done');
    await tick(10_000);
    expect(onResume).toHaveBeenCalledTimes(2);
  });
  it.each(['ABCD', undefined])('explains a browser launch failure after verification code %s', async userCode => {
    loginResult = { ...loginResult, userCode, browserOpened: false };
    await render();
    await click('Sign in & continue');
    expect(container.querySelector('.om-sa-action-card-copy p')?.textContent).toBe(
      (userCode ? 'Verification code: ABCD ' : '') + "Your browser didn't open — use Continue in browser.",
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(loginResult.authorizationUrl);
    expect(button('Cancel')).toBeTruthy();
  });
  it.each(['sign_in', 'upgrade_free', 'upgrade_go'] as const)('shows the included-plan idle CTA until clicked for restored %s cards', async kind => {
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await render({ ...card, kind });
    expect(container.textContent).toContain("You're signed in");
    expect(onResume).not.toHaveBeenCalled();
    await click('Continue');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(call => call[0].endsWith('/login') || call[0].endsWith('/subscription'))).toBe(false);
  });
  it('cancels authorization and ignores its in-flight poll', async () => {
    await render();
    await click('Sign in & continue');
    let resolve!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(done => { resolve = done; }));
    await tick(2_000);
    await click('Cancel');
    await act(async () => resolve({ state: 'signed-in', plan: 'plus', consoleUrl: '' }));
    expect(status()).toBe('idle');
    expect(onResume).not.toHaveBeenCalled();
  });
  it.each([{ plan: 'free' }, { plan: 'go' }])('skips login for an existing signed-in account: %j', async value => {
    account = { ...account, state: 'signed-in', ...value };
    await render();
    await click('Sign in & continue');
    expect(status()).toBe('opening_plan');
    expect(request.mock.calls.some(call => call[0] === 'settings/account/login')).toBe(false);
    expect(request.mock.calls.some(call => call[0] === 'settings/account/subscription')).toBe(false);
  });
  it.each([{ plan: 'enterprise' }, { plan: 'free', billingUnavailable: true }])('resumes unknown billing for Agent enforcement: %j', async value => {
    await render();
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', ...value };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: value.plan, key: card.id });
    expect(request.mock.calls.some(call => call[0] === 'settings/account/subscription')).toBe(false);
  });
  it('refreshes checkout immediately when the document becomes visible', async () => {
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render({ ...card, kind: 'upgrade_free' });
    await openPlansLink('Upgrade to Plus');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(onResume).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('waits for a pending cancellation before retrying sign-in', async () => {
    await render();
    await click('Sign in & continue');
    let finishCancel!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(resolve => { finishCancel = resolve; }));
    await click('Cancel');
    const calls = request.mock.calls.length;
    await click('Sign in & continue');
    expect(status()).toBe('starting');
    expect(request).toHaveBeenCalledTimes(calls);
    await act(async () => {
      account = { state: 'signed-out', consoleUrl: '' };
      finishCancel(account);
    });
    expect(status()).toBe('authorizing');
    expect(request.mock.calls.filter(call => call[0] === 'settings/account/login')).toHaveLength(2);
  });
  it('shows connector recovery and then offers plans after a retry', async () => {
    loginResult = { state: 'signed-out', consoleUrl: '', errorCode: 'connector_unavailable' };
    await render();
    await click('Sign in & continue');
    expect(container.textContent).toContain("The OpenDesign sign-in component isn't available on this device.");
    await click('Open account settings');
    expect(onOpenSettings).toHaveBeenCalledWith(card, 'account');
    account = { ...account, state: 'signed-in', plan: 'free' };
    await click('Retry');
    expect(status()).toBe('opening_plan');
    expect(reportEntitlementGateClick).toHaveBeenLastCalledWith('creative_studio', 'start_sign_in', 'studio_generate', { studio_id: 'game', entry_id: expect.any(String) });
  });
  it('does not resume twice in Strict Mode', async () => {
    await render(card, true);
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    await render({ ...card }, true);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('stops polling and ignores late responses after unmount', async () => {
    await render();
    await click('Sign in & continue');
    let resolve!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(done => { resolve = done; }));
    await tick(2_000);
    await act(async () => root.unmount());
    const calls = request.mock.calls.length;
    await act(async () => resolve({ state: 'signed-in', plan: 'plus', consoleUrl: '' }));
    await tick(10_000);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(onResume).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('AccountHandoffCard — publish sign-in', () => {
  const gameCard: SuperAgentActionCard = { id: 'action:web_publish_sign_in:game:g-1', kind: 'web_publish_sign_in', entry: 'agent_media_signed_out', provider: 'account', targetKind: 'game', targetId: 'g-1' };
  const designCard: SuperAgentActionCard = { ...gameCard, id: 'action:web_publish_sign_in:design:p-1', targetKind: 'design', targetId: 'p-1' };

  it.each(['free', 'go', 'plus', undefined])('signs in with the game publish hook and republishes once for plan %s', async plan => {
    await render(gameCard);
    expect(container.textContent).toContain('Sign in to publish online');
    await click('Sign in & publish');
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'game_publish_signin', entryId: expect.any(String) });
    account = { state: 'signed-in', consoleUrl: '', ...(plan ? { plan } : {}) };
    await tick(2_000);
    // Publishing only needs a signed-in account: no plans page, no billing reread.
    expect(request).not.toHaveBeenCalledWith('settings/account/subscription', expect.anything(), expect.anything());
    expect(request).not.toHaveBeenCalledWith('settings/account?refresh=true');
    expect(onResume).toHaveBeenCalledExactlyOnceWith(gameCard, { plan, key: gameCard.id });
    expect(status()).toBe('done');
    expect(container.textContent).toContain('Signed in — publishing again');
    await tick(10_000);
    await render({ ...gameCard });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('reports exposure and click under the publish hook and signs in with the clicked entry_id', async () => {
    await render(gameCard);
    expect(reportEntitlementGateView).toHaveBeenCalledExactlyOnceWith('creative_studio', 'game_publish_signin', { studio_id: 'game', entry_id: expect.any(String), publish_target: 'game' });
    const viewEntry = vi.mocked(reportEntitlementGateView).mock.lastCall![2]!.entry_id;
    await click('Sign in & publish');
    expect(reportEntitlementGateClick).toHaveBeenLastCalledWith('creative_studio', 'start_sign_in', 'game_publish_signin', { studio_id: 'game', entry_id: viewEntry, publish_target: 'game' });
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'game_publish_signin', entryId: viewEntry });
    await tick(5 * 60_000);
    await click('Retry');
    // A retry is a new attempt: click and login share a fresh entry_id.
    const retryEntry = vi.mocked(reportEntitlementGateClick).mock.lastCall![3]!.entry_id;
    expect(retryEntry).not.toBe(viewEntry);
    expect(request).toHaveBeenLastCalledWith('settings/account/login', 'POST', { hookId: 'game_publish_signin', entryId: retryEntry });
  });
  it('uses the cloud share hook for non-game targets', async () => {
    await render(designCard);
    expect(reportEntitlementGateView).toHaveBeenCalledWith('creative_studio', 'cloud_share_signin', { studio_id: 'game', entry_id: expect.any(String), publish_target: 'design' });
    await click('Sign in & publish');
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'cloud_share_signin', entryId: expect.any(String) });
  });
  it('offers Publish again when already signed in on a Free plan and republishes without signing in', async () => {
    account = { state: 'signed-in', plan: 'free', consoleUrl: '' };
    await render(gameCard);
    await click('Publish again');
    expect(request).not.toHaveBeenCalledWith('settings/account/login', expect.anything(), expect.anything());
    expect(onResume).toHaveBeenCalledExactlyOnceWith(gameCard, { plan: 'free', key: gameCard.id });
  });
  it('times out publish sign-in, cancels the connector, and republishes after retry', async () => {
    await render(gameCard);
    await click('Sign in & publish');
    await tick(5 * 60_000);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain('Sign-in timed out.');
    expect(request).toHaveBeenCalledWith('settings/account/cancel', 'POST');
    expect(onResume).not.toHaveBeenCalled();
    await click('Retry');
    expect(status()).toBe('authorizing');
    account = { state: 'signed-in', plan: 'go', consoleUrl: '' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('keeps the card retryable when the republish fails, then republishes once', async () => {
    account = { state: 'signed-in', plan: 'plus', consoleUrl: '' };
    onResume.mockRejectedValueOnce(new Error('Could not continue the conversation. Try again.'));
    await render(gameCard);
    await click('Publish again');
    expect(status()).toBe('failed');
    expect(container.textContent).toContain("Signed in, but couldn't publish again.");
    expect(container.textContent).toContain('Could not continue the conversation. Try again.');
    await click('Retry');
    expect(status()).toBe('done');
    expect(onResume).toHaveBeenCalledTimes(2);
    await render({ ...gameCard });
    expect(onResume).toHaveBeenCalledTimes(2);
  });
});
