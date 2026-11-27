import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { gatewayFor } from '../gateway/service.ts';
import { mediaUse, resetBalanceLowRecords } from '../gateway/media-use.ts';
import { assetOperation } from '../gateway/asset-operations.ts';
import { jobManage } from '../gateway/capability-center.ts';
import { cleanBillingUrl, decodeMonetizationShortlink, PRODUCT_ID } from '../shared/product-identity.ts';
import { saveTrackingPreference } from '../shared/tracking.ts';
import { uuid } from '../tracking/core.ts';

async function withTelemetryEnvUnlocked<T>(fn: () => Promise<T>): Promise<T> {
  const prevTelemetry = process.env.OPENMOTION_TELEMETRY;
  const prevDnt = process.env.DO_NOT_TRACK;
  delete process.env.OPENMOTION_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  try {
    return await fn();
  } finally {
    if (prevTelemetry === undefined) delete process.env.OPENMOTION_TELEMETRY;
    else process.env.OPENMOTION_TELEMETRY = prevTelemetry;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
  }
}

for (const plan of ['free', 'go'] as const) {
  test(`${plan} inspect returns an attributed shortlink without account intents or opening a browser`, t => withTelemetryEnvUnlocked(() => fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    t.after(() => gateway.close());
    t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan, billingUnavailable: false }));
    // A signed-in production account must still return a credential-free shortlink.
    await mkdir(gateway.account.home, { recursive: true });
    await writeFile(path.join(store.directory, 'account/session.json'), JSON.stringify({ id: 'test-session' }));
    await writeFile(path.join(gateway.account.home, 'config.json'), JSON.stringify({ profiles: { prod: {
      apiUrl: 'https://amr-api.open-design.ai', user: { id: 'fixture-user' },
      controlKey: 'test-control', controlKeyId: 'test-id', runtimeKey: 'test-runtime',
    } } }));
    t.mock.method(gateway.account, 'mediaModels', async () => []);
    const fetcher = t.mock.fn(async () => Response.json({ intentId: 'must-not-be-exposed' }));
    gateway.account.options.fetcher = fetcher;
    const upgradeLink = gateway.account.upgradeLink.bind(gateway.account);
    t.mock.method(gateway.account, 'upgradeLink', (...args: Parameters<typeof upgradeLink>) => {
      assert.equal(args.length, 2, 'inspect supplies the entry UUID and attribution options');
      assert.match(args[0], uuid);
      assert.deepEqual(args[1], {
        telemetryEnabled: true,
        channel: 'mcp_stdio',
        host: 'unknown',
        touchpoint: `agent_media_upgrade_${plan}`,
        studioId: 'unknown',
        modality: 'all',
      });
      return upgradeLink(...args);
    });
    const checkAttribution = (url: string, entryId: string) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://open-design.ai');
      assert.match(target.pathname, /^\/t\/[A-Za-z0-9_-]+$/);
      assert.equal(target.search, '');
      assert.equal(target.hash, '');
      const decoded = decodeMonetizationShortlink(url);
      assert.deepEqual(decoded, {
        version: 'v1',
        target: 'd',
        entryId,
        product: PRODUCT_ID,
        channel: 'mcp_stdio',
        host: 'unknown',
        touchpoint: `agent_media_upgrade_${plan}`,
        studioId: 'unknown',
        modality: 'all',
        placementId: 'mcp_stdio__unknown__unknown__all',
        destinationUrl: 'https://open-design.ai/cloud/dashboard?billing=plan',
      });
    };
    const result = await mediaUse(store, { action: 'inspect' });
    assert.ok(result.upgrade);
    assert.match(result.upgrade.entryId, uuid);
    assert.equal(result.upgrade.plan, 'plus');
    assert.match(result.upgrade.instruction, /clickable.*Upgrade to Plus \/ 升级到 Plus.*inspect again after payment.*original request/);
    checkAttribution(result.upgrade.url, result.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0, 'inspect must never request an account intent');
    assert.equal(result.settingsHandoff.arguments.entry, `agent_media_upgrade_${plan}`);
    assert.deepEqual(result._upgradeLinkResult, {
      entry_from: `agent_media_upgrade_${plan}`,
      outcome: 'success',
      entry_id: result.upgrade.entryId,
      channel: 'mcp_stdio',
      studio_id: 'unknown',
      modality: 'all',
    });
    assert.doesNotMatch(JSON.stringify(result), /test-control|test-runtime|fixture-user/);

    // Re-inspection creates a fresh attribution ID without creating credentials.
    const next = await mediaUse(store, { action: 'inspect' });
    assert.ok(next.upgrade);
    assert.notEqual(next.upgrade.entryId, result.upgrade.entryId);
    checkAttribution(next.upgrade.url, next.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0);
  })));
}

test('included, signed-out, rejected-key and usable alternative routes do not generate upgrade links', t => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  let state = 'signed-out', plan = 'plus';
  t.mock.method(gateway.account, 'summary', async () => ({ state, plan, billingUnavailable: false }));
  const open = t.mock.method(gateway.account, 'upgradeLink', () => { throw new Error('Must not generate an upgrade link'); });
  const inspect = async (entry?: string) => {
    const result = await mediaUse(store, { action: 'inspect' });
    assert.equal(Object.hasOwn(result, 'upgrade'), false);
    assert.equal(Object.hasOwn(result, '_upgradeLinkResult'), false);
    assert.equal(result.settingsHandoff.arguments.entry, entry);
  };
  await inspect('agent_media_signed_out');
  state = 'signed-in';
  await inspect();
  state = 'signed-out';
  await gateway.configureProvider('atlascloud', { apiKey: 'test-key' });
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'rejected');
  await inspect('agent_media_key_rejected');
  state = 'signed-in'; plan = 'go';
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'verified');
  await inspect();
  assert.equal(open.mock.callCount(), 0);
}));

test('upgrade URL exceptions preserve the settings handoff without returning upgrade', t => withTelemetryEnvUnlocked(() => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan: 'go', billingUnavailable: false }));
  t.mock.method(gateway.account, 'upgradeLink', () => { throw new Error('private-account-error'); });
  const result = await mediaUse(store, { action: 'inspect' });
  assert.equal(Object.hasOwn(result, 'upgrade'), false);
  assert.deepEqual(result.settingsHandoff.arguments, { target: 'providers', entry: 'agent_media_upgrade_go' });
  assert.deepEqual(result._upgradeLinkResult, {
    entry_from: 'agent_media_upgrade_go',
    outcome: 'failure',
    channel: 'mcp_stdio',
    studio_id: 'unknown',
    modality: 'all',
  });
  assert.doesNotMatch(JSON.stringify(result), /private-account-error/);
})));

test('opted-out telemetry returns clean billing URLs without /t/ shortlinks or _upgradeLinkResult', t => withTelemetryEnvUnlocked(() => fixture(async store => {
  resetBalanceLowRecords();
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan: 'free', billingUnavailable: false }));
  await saveTrackingPreference(store.directory, false);

  const inspected = await mediaUse(store, { action: 'inspect' });
  assert.equal(inspected.upgrade?.url, cleanBillingUrl('d'));
  assert.equal(Object.hasOwn(inspected, '_upgradeLinkResult'), false);

  const prevEnv = process.env.OPENMOTION_TELEMETRY;
  await saveTrackingPreference(store.directory, true);
  process.env.OPENMOTION_TELEMETRY = '0';
  try {
    const envOptedOut = await mediaUse(store, { action: 'inspect' });
    assert.equal(envOptedOut.upgrade?.url, cleanBillingUrl('d'));
    assert.equal(Object.hasOwn(envOptedOut, '_upgradeLinkResult'), false);
  } finally {
    if (prevEnv === undefined) delete process.env.OPENMOTION_TELEMETRY;
    else process.env.OPENMOTION_TELEMETRY = prevEnv;
  }
})));

test('BALANCE_LOW job status deduplicates _upgradeLinkResult per job.id across polls and excludes gui calls', t => withTelemetryEnvUnlocked(() => fixture(async store => {
  resetBalanceLowRecords();
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  const projectId = store.projectCatalog().activeId;
  const motionJob = {
    id: 'job-balance-motion-1',
    state: 'failed' as const,
    phase: 'submitting' as const,
    projectId,
    modality: 'video' as const,
    prompt: 'explosion',
    model: { id: 'account:kling', provider: 'account', modelId: 'kling', label: 'Kling', modality: 'video' as const, source: 'live' as const },
    errorCode: 'BALANCE_LOW',
    error: 'Your OpenDesign balance is too low for this request. Top up, then try again.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const assetJob = {
    ...motionJob,
    id: 'job-balance-asset-1',
    projectId: undefined,
    modality: 'audio' as const,
    library: { title: 'Boss SFX' },
  };
  t.mock.method(gateway, 'getJob', async (id: string) => id === motionJob.id ? motionJob : assetJob);
  const host = { host_agent: 'cursor', host_agent_source: 'client_info', mcp_client_name: 'cursor', mcp_client_version: '1.0' } as const;

  // GUI status call never exposes topup or _upgradeLinkResult and must not consume MCP dedup.
  const guiRes = await mediaUse(store, { action: 'status', projectId, jobId: motionJob.id }, undefined, host, { channel: 'gui' });
  assert.equal(Object.hasOwn(guiRes, 'topup'), false);
  assert.equal(Object.hasOwn(guiRes, '_upgradeLinkResult'), false);

  // First MCP poll emits topup + settingsHandoff + _upgradeLinkResult once.
  const first = await mediaUse(store, { action: 'status', projectId, jobId: motionJob.id }, undefined, host, { channel: 'mcp', mcpChannel: 'mcp_http' });
  assert.ok(first.topup);
  assert.match(first.topup.entryId, uuid);
  assert.deepEqual(first.settingsHandoff, { tool: 'openmotion_open_preview', arguments: { target: 'providers', entry: 'agent_media_balance_low' } });
  assert.deepEqual(decodeMonetizationShortlink(first.topup.url), {
    version: 'v1',
    target: 'r',
    entryId: first.topup.entryId,
    product: PRODUCT_ID,
    channel: 'mcp_http',
    host: 'cursor',
    touchpoint: 'agent_media_balance_low',
    studioId: 'motion',
    modality: 'video',
    placementId: 'mcp_http__cursor__motion__video',
    destinationUrl: 'https://open-design.ai/cloud/dashboard?billing=recharge',
  });
  assert.deepEqual(first._upgradeLinkResult, {
    entry_from: 'agent_media_balance_low',
    entry_id: first.topup.entryId,
    outcome: 'success',
    channel: 'mcp_http',
    studio_id: 'motion',
    modality: 'video',
  });

  // Subsequent polls keep the same topup link/entryId + settingsHandoff, without emitting _upgradeLinkResult again.
  const second = await mediaUse(store, { action: 'status', projectId, jobId: motionJob.id }, undefined, host, { channel: 'mcp', mcpChannel: 'mcp_http' });
  assert.deepEqual(second.topup, first.topup);
  assert.deepEqual(second.settingsHandoff, first.settingsHandoff);
  assert.equal(Object.hasOwn(second, '_upgradeLinkResult'), false);

  // Studio GUI assetOperation (including asset-chat) never exposes topup/_upgradeLinkResult and must not consume MCP dedup.
  const assetGuiRes: any = await assetOperation(store, { action: 'status', jobId: assetJob.id }, undefined, undefined, 'gui');
  assert.equal(Object.hasOwn(assetGuiRes, 'topup'), false);
  assert.equal(Object.hasOwn(assetGuiRes, '_upgradeLinkResult'), false);

  // Asset library job via assetOperation and jobManage sets studio_id='assets' and shares the per-jobId dedup.
  const assetFirst: any = await assetOperation(store, { action: 'status', jobId: assetJob.id }, undefined, undefined, 'mcp', host, 'mcp_stdio');
  assert.ok(assetFirst.topup);
  assert.deepEqual(assetFirst._upgradeLinkResult, {
    entry_from: 'agent_media_balance_low',
    entry_id: assetFirst.topup.entryId,
    outcome: 'success',
    channel: 'mcp_stdio',
    studio_id: 'assets',
    modality: 'audio',
  });
  assert.equal(decodeMonetizationShortlink(assetFirst.topup.url)?.studioId, 'assets');
  assert.equal(decodeMonetizationShortlink(assetFirst.topup.url)?.modality, 'audio');

  const assetSecond: any = await jobManage(store, { action: 'status', jobId: assetJob.id }, undefined, 'mcp', host, 'mcp_stdio');
  assert.deepEqual(assetSecond.topup, assetFirst.topup);
  assert.equal(Object.hasOwn(assetSecond, '_upgradeLinkResult'), false);

  // Opt-out immediately downgrades cached job status link to clean recharge URL.
  await saveTrackingPreference(store.directory, false);
  const optedOut = await mediaUse(store, { action: 'status', projectId, jobId: motionJob.id }, undefined, host, { channel: 'mcp', mcpChannel: 'mcp_http' });
  assert.equal(optedOut.topup?.url, cleanBillingUrl('r'));
  assert.equal(Object.hasOwn(optedOut, '_upgradeLinkResult'), false);
})));
