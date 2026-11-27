import { randomUUID } from 'node:crypto';
import { ToolInputError } from '../shared/tool-input-error.ts';
import { telemetryEnabledFor, type OmTracking } from '../shared/tracking.ts';
import type { HostContext } from '../tracking/host.ts';
import { mediaGenerationError } from '../tracking/tool-fields.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { GenerateInput, GenerationJob, GatewayStatus, Modality, ProviderState } from '../shared/gateway.ts';
import { cleanBillingUrl, type MonetizationModality } from '../shared/product-identity.ts';
import type { ProviderSetupEntry } from '../shared/workspace-url.ts';
import { isMediaProvider, registeredProvider } from '../shared/provider-registry.ts';
import { gatewayFor, type ModelGateway } from './service.ts';
import { getWorkflow } from '../shared/workflow.ts';

export type McpChannel = 'mcp_stdio' | 'mcp_http';
export type MediaUseOptions = {
  channel?: 'gui' | 'mcp';
  mcpChannel?: McpChannel;
  emitUpgradeLinkResult?: boolean;
};

type UpgradeLinkResultPayload = {
  entry_from: 'agent_media_upgrade_free' | 'agent_media_upgrade_go' | 'agent_media_balance_low';
  outcome: 'success' | 'failure';
  entry_id?: string;
  channel: McpChannel;
  studio_id: string;
  modality: MonetizationModality;
};

type BalanceLowRecord = {
  entryId: string;
  url: string;
  reported: boolean;
  telemetryEnabled: boolean;
};

const MAX_BALANCE_LOW_RECORDS = 500;
const balanceLowRecords = new Map<string, BalanceLowRecord>();
const BALANCE_LOW_TOPUP_INSTRUCTION = 'Present url to the user as a clickable "Top up or upgrade / 充值或升级" link, then retry after credits recover.';

export function resetBalanceLowRecords() {
  balanceLowRecords.clear();
}

export function isBalanceLowJob(job: GenerationJob): boolean {
  if (job.state !== 'failed') return false;
  const rawCode = (job as { errorCode?: unknown }).errorCode;
  if (typeof rawCode === 'string' && /^(?:BALANCE_LOW|insufficient_balance|insufficient_credits|credits_exhausted|quota_exceeded)$/i.test(rawCode.trim())) {
    return true;
  }
  if (typeof job.error === 'string' && job.error.trim()) {
    return mediaGenerationError(job.error, job.phase) === 'BALANCE_LOW';
  }
  return false;
}

export async function balanceLowTopupForJob(
  gateway: ModelGateway,
  job: GenerationJob,
  options: {
    channel: 'gui' | 'mcp';
    mcpChannel: McpChannel;
    studioId: 'motion' | 'assets';
    directory: string;
    tracking?: OmTracking;
    host?: HostContext;
    emitUpgradeLinkResult?: boolean;
  },
): Promise<{
  topup?: { url: string; entryId: string; instruction: string };
  settingsHandoff?: ReturnType<typeof buildMediaSettingsHandoff>;
  _upgradeLinkResult?: UpgradeLinkResultPayload;
}> {
  if (options.channel === 'gui' || !isBalanceLowJob(job)) return {};
  const telemetryEnabled = telemetryEnabledFor(options.directory, options.tracking);
  const shouldEmit = telemetryEnabled && options.emitUpgradeLinkResult !== false;
  const hostAgent = options.host?.host_agent ?? 'unknown';
  const existing = balanceLowRecords.get(job.id);
  const settingsHandoff = buildMediaSettingsHandoff('agent_media_balance_low');

  if (existing) {
    let url = existing.url;
    if (!telemetryEnabled) {
      url = cleanBillingUrl('r');
    } else if (!existing.telemetryEnabled) {
      try {
        url = (await gateway.account.topupLink(existing.entryId, {
          telemetryEnabled: true,
          channel: options.mcpChannel,
          host: hostAgent,
          touchpoint: 'agent_media_balance_low',
          studioId: options.studioId,
          modality: job.modality,
        })).url;
        existing.url = url;
        existing.telemetryEnabled = true;
      } catch {
        return { settingsHandoff };
      }
    }
    let upgradeLinkResult: UpgradeLinkResultPayload | undefined;
    if (shouldEmit && !existing.reported) {
      existing.reported = true;
      upgradeLinkResult = {
        entry_from: 'agent_media_balance_low',
        entry_id: existing.entryId,
        outcome: 'success',
        channel: options.mcpChannel,
        studio_id: options.studioId,
        modality: job.modality,
      };
    }
    return {
      topup: { url, entryId: existing.entryId, instruction: BALANCE_LOW_TOPUP_INSTRUCTION },
      settingsHandoff,
      ...(upgradeLinkResult ? { _upgradeLinkResult: upgradeLinkResult } : {}),
    };
  }

  const entryId = randomUUID();
  try {
    const { url } = await gateway.account.topupLink(entryId, {
      telemetryEnabled,
      channel: options.mcpChannel,
      host: hostAgent,
      touchpoint: 'agent_media_balance_low',
      studioId: options.studioId,
      modality: job.modality,
    });
    if (balanceLowRecords.size >= MAX_BALANCE_LOW_RECORDS) {
      const oldest = balanceLowRecords.keys().next().value;
      if (oldest !== undefined) balanceLowRecords.delete(oldest);
    }
    balanceLowRecords.set(job.id, { entryId, url, reported: shouldEmit, telemetryEnabled });
    return {
      topup: { url, entryId, instruction: BALANCE_LOW_TOPUP_INSTRUCTION },
      settingsHandoff,
      ...(shouldEmit ? {
        _upgradeLinkResult: {
          entry_from: 'agent_media_balance_low' as const,
          entry_id: entryId,
          outcome: 'success' as const,
          channel: options.mcpChannel,
          studio_id: options.studioId,
          modality: job.modality,
        },
      } : {}),
    };
  } catch {
    return {
      settingsHandoff,
      ...(shouldEmit ? {
        _upgradeLinkResult: {
          entry_from: 'agent_media_balance_low' as const,
          outcome: 'failure' as const,
          channel: options.mcpChannel,
          studio_id: options.studioId,
          modality: job.modality,
        },
      } : {}),
    };
  }
}

type MediaProviderLike = Pick<ProviderState, 'id' | 'available'> & Partial<Pick<ProviderState, 'mediaEntitlement'>>;
type SetupProviderLike = Pick<ProviderState, 'id' | 'available' | 'configured' | 'verification'>
  & Partial<Pick<ProviderState, 'mediaEntitlement' | 'plan'>>;

export function isMediaProviderUsable(provider: MediaProviderLike): boolean {
  return Boolean(provider.available && !(provider.id === 'account' && provider.mediaEntitlement === 'not-included'));
}

export function resolveMediaSetupEntry(
  providers: readonly SetupProviderLike[],
  options?: {
    modality?: Modality;
    capabilities?: GatewayStatus['capabilities'];
  },
): ProviderSetupEntry | undefined {
  const hasUsableForScope = options?.capabilities
    ? (options.modality
      ? options.capabilities.some(cap => cap.modality === options.modality && cap.available)
      : options.capabilities.some(cap => cap.available))
    : providers.some(isMediaProviderUsable);
  if (hasUsableForScope) return undefined;
  const account = providers.find(p => p.id === 'account');
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'go') return 'agent_media_upgrade_go';
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'free') return 'agent_media_upgrade_free';
  if (providers.some(p => p.id !== 'account' && p.configured && p.verification === 'rejected')) return 'agent_media_key_rejected';
  if (!account?.configured) return 'agent_media_signed_out';
  return undefined;
}

export function buildMediaSettingsHandoff(entry?: ProviderSetupEntry) {
  return {
    tool: 'openmotion_open_preview' as const,
    arguments: { target: 'providers' as const, ...(entry ? { entry } : {}) },
  };
}

export async function mediaUse(
  store: WorkspaceStore,
  args: any,
  tracking?: OmTracking,
  host?: HostContext,
  options?: MediaUseOptions,
) {
  const gateway = gatewayFor(store, tracking);
  const channel: 'gui' | 'mcp' = options?.channel === 'gui' ? 'gui' : 'mcp';
  const mcpChannel: McpChannel = options?.mcpChannel === 'mcp_http' ? 'mcp_http' : 'mcp_stdio';
  const rootDirectory = (store.workspaceStore ?? store).directory;
  const connections = await gateway.connections.list();
  // Codex is a local image Agent: Settings offers it for images, so discovery accepts it; new images go through openmotion_assets_use.
  const supported = (id: string) => isMediaProvider(id) || id === 'codex' || registeredProvider(id)?.integration === 'account' || connections.some(p => p.id === id && p.protocol === 'openai' && !p.setupRequired);
  const referenceSection = (id: string) => registeredProvider(id)?.reference ?? 'compatible';
  if (args.provider !== undefined && !supported(args.provider)) throw new ToolInputError('unsupported media provider', 'provider', 'invalid_enum');
  if (args.action === 'inspect') {
    const status = await gateway.status(false, { refreshAccount: true });
    const providers = status.providers.filter(p => supported(p.id) && (isMediaProvider(p.id) || p.configured || p.id === 'account'));
    const modality = typeof args.modality === 'string' && ['image', 'video', 'audio'].includes(args.modality)
      ? args.modality as Modality
      : undefined;
    const entry = resolveMediaSetupEntry(providers, modality ? { modality, capabilities: status.capabilities } : undefined);
    const telemetryEnabled = telemetryEnabledFor(rootDirectory, tracking);
    const studioId = args.projectId ? 'motion' : 'unknown';
    const effectiveModality: MonetizationModality = modality ?? 'all';
    const hostAgent = host?.host_agent ?? 'unknown';
    let upgrade: { url: string; entryId: string; plan: 'plus'; instruction: string } | undefined;
    let upgradeLinkResult: UpgradeLinkResultPayload | undefined;
    if (entry === 'agent_media_upgrade_free' || entry === 'agent_media_upgrade_go') {
      try {
        const entryId = randomUUID();
        const { url } = await gateway.account.upgradeLink(entryId, {
          telemetryEnabled,
          channel: mcpChannel,
          host: hostAgent,
          touchpoint: entry,
          studioId,
          modality: effectiveModality,
        });
        upgrade = { url, entryId, plan: 'plus', instruction: 'Present url to the user as a clickable "Upgrade to Plus / 升级到 Plus" link, then inspect again after payment and continue the original request.' };
        if (channel !== 'gui' && telemetryEnabled) {
          upgradeLinkResult = {
            entry_from: entry,
            outcome: 'success',
            entry_id: entryId,
            channel: mcpChannel,
            studio_id: studioId,
            modality: effectiveModality,
          };
        }
      } catch {
        if (channel !== 'gui' && telemetryEnabled) {
          upgradeLinkResult = {
            entry_from: entry,
            outcome: 'failure',
            channel: mcpChannel,
            studio_id: studioId,
            modality: effectiveModality,
          };
        }
      }
    }
    return { providers,
      defaults: status.routes,
      settings: 'Open Settings > Model providers > OpenDesign to sign in or upgrade to Plus in place. Save or replace API keys in Model providers.',
      settingsHandoff: buildMediaSettingsHandoff(entry),
      ...(upgrade ? { upgrade } : {}),
      // Service metadata crosses the local RPC bridge; MCP (stdio + HTTP) strips and records it once.
      ...(upgradeLinkResult ? { _upgradeLinkResult: upgradeLinkResult } : {}),
      references: status.providers.filter(p => supported(p.id)).map(p => ({ provider: p.id, uri: `openmotion://workflow/media/${referenceSection(p.id)}` })),
      credentials: 'Read by the local service; keys are never returned to the Agent.' };
  }
  if (args.action === 'reference') {
    if (!args.provider) throw new ToolInputError('provider is required', 'provider', 'missing');
    return getWorkflow(referenceSection(args.provider), 'media');
  }
  if (args.action === 'models') {
    const providers = (await gateway.status()).providers.filter(p => supported(p.id) && (!args.provider || p.id === args.provider) && p.available);
    const pages = await Promise.all(providers.map(provider => gateway.listModels({ provider: provider.id, modality: args.modality, refresh: args.refresh, query: args.query, offset: args.offset, limit: args.limit })));
    return { providers: providers.map(p => p.id), catalogs: pages, setupRequired: !providers.length };
  }
  if (!args.projectId) throw new ToolInputError('projectId is required', 'projectId', 'missing');
  if (!store.projectCatalog().projects.some(p => p.id === args.projectId)) throw new Error('PROJECT_NOT_FOUND');
  if (args.action === 'generate') {
    if (args.provider === 'codex') throw new ToolInputError('Generate Codex images with openmotion_assets_use (model codex:image-generation); project-direct generation does not accept Codex', 'provider', 'invalid_enum');
    const missing = ['provider', 'model', 'requestId', 'modality'].find(field => !args[field]);
    if (missing || typeof args.prompt !== 'string') {
      throw new ToolInputError('provider, model, projectId, requestId, modality and prompt are required', missing ?? 'prompt', 'missing');
    }
    const job = await gateway.submit({ projectId: args.projectId, model: `${args.provider}:${args.model}`, modality: args.modality,
      prompt: args.prompt, parameters: args.parameters, mode: args.mode, referenceAsset: args.referenceAsset, idempotencyKey: args.requestId } as GenerateInput, host, { entrySurface: 'mcp_media_use' });
    return { projectId: job.projectId, job, next: { action: 'status', projectId: job.projectId, jobId: job.id } };
  }
  if (args.action === 'status' || args.action === 'cancel' || args.action === 'retry_save' || args.action === 'resume') {
    const job = await gateway.getJob(args.jobId);
    if (job.projectId !== args.projectId || job.model.provider === 'codex') throw new Error('GENERATION_NOT_FOUND: job does not belong to this project');
    if (args.action !== 'status' && !args.requestId) {
      const err = new ToolInputError('requestId is required', 'requestId', 'missing');
      if (args.action === 'resume' || args.action === 'retry_save') gateway.recordRetryRejection(job, args.action, err);
      throw err;
    }
    if (args.action === 'resume') return { projectId: job.projectId, job: await gateway.resume(job.id, args.requestId) };
    if (args.action === 'retry_save') return { projectId: job.projectId, job: await gateway.retrySave(job.id) };
    if (args.action === 'cancel') return { projectId: job.projectId, job: await gateway.cancel(job.id, { source: 'mcp' }) };
    const topupFields = await balanceLowTopupForJob(gateway, job, {
      channel,
      mcpChannel,
      studioId: 'motion',
      directory: rootDirectory,
      tracking,
      host,
      emitUpgradeLinkResult: options?.emitUpgradeLinkResult,
    });
    return { projectId: job.projectId, job, ...topupFields };
  }
  throw new ToolInputError('unsupported media action', 'action', 'invalid_enum');
}
