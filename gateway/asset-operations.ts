import { buildCapabilityParameters, findCapability } from '../shared/capability-registry.ts';
import type { OmTracking } from '../shared/tracking.ts';
import type { HostContext } from '../tracking/host.ts';
import type { MediaGenerationEntrySurface } from '../tracking/tool-fields.ts';
import path from 'node:path';
import type { WorkspaceStore } from '../workspace.ts';
import { AssetLibrary } from './asset-library.ts';
import { preflightAssetCapabilityGenerate } from './capability-center.ts';
import { balanceLowTopupForJob, type McpChannel } from './media-use.ts';
import {
  classifyRejectionError,
  extractRequestReferenceMeta,
  isMediaTelemetryModality,
  recordPreGatewayRejection,
  spatialKindForCapability,
} from './media-telemetry.ts';
import { gatewayFor } from './service.ts';
import { requireNativeRuntime } from '../scripts/npm-runtime.mjs';
import { pluginRoot } from '../hyperframes.ts';
import { readLibraryAsset } from './asset-read.ts';

export async function assetOperation(
  store: WorkspaceStore,
  args: any,
  importProject?: (input: any, options?: { receiptName: string; reusePinnedContent: boolean }) => Promise<any>,
  tracking?: OmTracking,
  channel: 'gui' | 'mcp' = 'mcp',
  host?: HostContext,
  mcpChannel: McpChannel = 'mcp_stdio',
  emitUpgradeLinkResult = true,
  entrySurfaceOverride?: MediaGenerationEntrySurface,
) {
  const library = new AssetLibrary(store), gateway = gatewayFor(store, tracking);
  if (args.action === 'list') return library.list(args);
  if (args.action === 'read') return readLibraryAsset(library, args);
  if (args.action === 'get') {
    const asset = await library.get(args.assetId);
    return { asset, ...(args.versionId ? { version: (await library.resolve({ assetId: args.assetId, versionId: args.versionId }, true)).version } : {}) };
  }
  if (args.action === 'update') return { asset: await library.update(args.assetId, args.changes) };
  if (args.action === 'import') {
    if (!/\.glb$/i.test(String(args.sourcePath ?? ''))) {
      await requireNativeRuntime(pluginRoot, 'media');
    }
    return { asset: await library.importFile(args.sourcePath, { requestId: args.requestId, name: args.name || path.basename(args.sourcePath), assetId: args.assetId, parentVersionId: args.parentVersionId }) };
  }
  if (args.action === 'generate') {
    const effectiveTracking = tracking ?? gateway.options.tracking;
    const entrySurface: MediaGenerationEntrySurface = entrySurfaceOverride ?? (channel === 'gui' ? 'studio' : 'mcp_assets_use');
    let effectiveOptions = args.capabilityOptions;
    let effectiveParameters = args.parameters;
    let enteredGatewaySubmit = false;
    try {
      if (!args.requestId || !args.model) throw new Error('Choose a model and supply a stable requestId');
      if (typeof args.capabilityId === 'string' && args.capabilityId.trim()) {
        const preflight = await preflightAssetCapabilityGenerate(store, args, effectiveTracking, channel);
        if (Object.keys(preflight.options).length) effectiveOptions = preflight.options;
        if (preflight.capability.executor.kind === 'dedicated-model' || preflight.capability.executor.kind === 'prompt-preset') {
          effectiveParameters = buildCapabilityParameters(preflight.capability, preflight.options, args.parameters ?? {});
        }
      }
      await requireNativeRuntime(pluginRoot, 'media');
      enteredGatewaySubmit = true;
      const job = await gateway.submit({ modality: args.modality, prompt: args.prompt, model: args.model, mode: args.mode,
        idempotencyKey: args.requestId, parameters: effectiveParameters,
        ...(args.capabilityId ? { capabilityId: args.capabilityId } : {}),
        ...(effectiveOptions ? { capabilityOptions: effectiveOptions } : {}),
        library: { assetId: args.assetId, title: args.name, parentVersionId: args.parentVersionId,
          ...(args.capabilityId ? { capabilityId: args.capabilityId } : {}),
          ...(effectiveOptions ? { capabilityOptions: effectiveOptions } : {}),
          references: args.references, conversationId: args.conversationId } }, host, { entrySurface });
      return { job, next: { action: 'status', jobId: job.id } };
    } catch (error) {
      if (!enteredGatewaySubmit) {
        const cap = typeof args.capabilityId === 'string' ? findCapability(args.capabilityId) : undefined;
        const resolvedModality = isMediaTelemetryModality(args.modality)
          ? args.modality
          : isMediaTelemetryModality(cap?.modality) ? cap.modality : undefined;
        if (resolvedModality) {
          const { reason, category } = classifyRejectionError(error);
          const { referenceCount, isEdit } = extractRequestReferenceMeta(args);
          recordPreGatewayRejection(effectiveTracking, {
            modality: resolvedModality,
            executorKind: cap?.executor.kind === 'script' ? 'script' : 'gateway',
            capabilityId: typeof args.capabilityId === 'string' ? args.capabilityId : undefined,
            spatialKind: spatialKindForCapability(cap?.id),
            entrySurface,
            destination: 'library',
            referenceCount,
            isEdit,
            hasIdempotencyKey: typeof args.requestId === 'string' && args.requestId.length > 0,
            parameters: args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters) ? args.parameters : undefined,
            reason,
            category,
          }, host);
        }
      }
      throw error;
    }
  }
  if (args.action === 'jobs') return { jobs: (await gateway.listJobs()).filter(job => (job.library || job.saveToLibrary) && (!args.conversationId || job.library?.conversationId === args.conversationId)).slice(0, 100) };
  if (args.action === 'status' || args.action === 'cancel' || args.action === 'retry_save' || args.action === 'resume') {
    const job = await gateway.getJob(args.jobId);
    if (!job.library && !job.saveToLibrary) throw new Error('ASSET_JOB_NOT_FOUND');
    if (['retry_save', 'resume'].includes(args.action) && !args.requestId) {
      const err = new Error('A stable requestId is required');
      gateway.recordRetryRejection(job, args.action, err);
      throw err;
    }
    if (args.action === 'resume') return { job: await gateway.resume(job.id, args.requestId) };
    if (args.action === 'retry_save') return { job: await gateway.retrySave(job.id) };
    if (args.action === 'cancel') return { job: await gateway.cancel(job.id, { source: channel === 'gui' ? 'studio' : 'mcp' }) };
    const topupFields = await balanceLowTopupForJob(gateway, job, {
      channel,
      mcpChannel,
      studioId: 'assets',
      directory: (store.workspaceStore ?? store).directory,
      tracking,
      host,
      emitUpgradeLinkResult,
    });
    return { job, ...topupFields };
  }
  if (args.action === 'import_to_project') {
    if (!importProject || !args.projectId || !args.requestId) throw new Error('Explicit projectId and requestId are required');
    const { asset, version, filename } = await library.resolve({ assetId: args.assetId, versionId: args.versionId });
    return importProject({ projectId: args.projectId, requestId: args.requestId,
      items: [{ itemId: `library-${asset.id}-${version.id}`, sourcePath: filename, name: args.name ?? asset.name ?? version.name ?? version.filename, expectedSha256: version.sha256 }] },
      { receiptName: args.name ?? version.name ?? version.filename, reusePinnedContent: true });
  }
  throw new Error('Unknown asset operation');
}
