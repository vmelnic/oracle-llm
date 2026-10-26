import fs from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import path from 'path';

import { OpenApiDetector } from './detectors/openapi.js';
import { SymfonyRouteDetector } from './detectors/symfony-route.js';
import { LaravelRouteDetector } from './detectors/laravel-route.js';
import { DatabaseSchemaDetector } from './detectors/database-schema.js';
import { PrismaDetector } from './detectors/prisma.js';
import { GraphQLDetector } from './detectors/graphql.js';
import { ApiPlatformDetector } from './detectors/api-platform.js';
import { ProtobufDetector } from './detectors/protobuf.js';
import { KafkaTopicDetector } from './detectors/kafka-topic.js';
import { TypeOrmDetector } from './detectors/typeorm.js';
import { DoctrineMigrationDetector } from './detectors/doctrine-migration.js';
import { EventBusDetector } from './detectors/event-bus.js';

export class ContractRegistry {
  constructor(store) {
    this.store = store;
    this.detectors = [];
    this.scanHadErrors = false;
  }

  registerDetector(detector) {
    this.detectors.push(detector);
  }

  async scan(subproject) {
    const surfaces = [];
    this.scanHadErrors = false;
    for (const detector of this.detectors) {
      try {
        const found = await detector.detect(subproject);
        surfaces.push(...found);
      } catch {
        this.scanHadErrors = true;
        // detector failed for this subproject — skip
      }
    }
    return surfaces;
  }

  async index(subproject, { previousSurfaces = [] } = {}) {
    const detectedSurfaces = await this.scan(subproject);
    const surfaces = this.scanHadErrors
      ? mergeSurfaces(previousSurfaces, detectedSurfaces)
      : detectedSurfaces;
    const write = () => this._writeSurfaces(subproject, previousSurfaces, surfaces);
    if (typeof this.store.runInTransaction === 'function') this.store.runInTransaction(write);
    else write();
    return { surfacesIndexed: surfaces.length, surfaces, scanIncomplete: this.scanHadErrors };
  }

  _writeSurfaces(subproject, previousSurfaces, surfaces) {
    if (!this.scanHadErrors) {
      this._removeStaleSurfaces(subproject.id, previousSurfaces, surfaces);
    }

    for (const surface of surfaces) {
      const { startLine, endLine } = surfaceLines(surface);
      const existing = this.store.getNodesByFile?.(subproject.id, surface.path)
        ?.find(node => node.symbol === surface.symbol && node.kind === surface.kind && node.start_line === startLine);
      const existingMetadata = parseMetadata(existing?.metadata);
      const sources = new Set(existingMetadata._oracle_sources || []);
      sources.add('contract');
      const hasNonContractSource = [...sources].some(source => source !== 'contract');
      const metadata = {
        ...(hasNonContractSource ? existingMetadata : (surface.metadata || {})),
        _oracle_sources: [...sources],
        _contract: surface.metadata || {},
      };

      if (existing && hasNonContractSource) {
        this.store.updateNodeMetadata(existing.id, JSON.stringify(metadata));
        continue;
      }

      this.store.upsertNode({
        subproject_id: subproject.id,
        path: surface.path,
        lang: surface.lang || subproject.language,
        symbol: surface.symbol,
        kind: surface.kind,
        start_line: startLine,
        end_line: endLine,
        exported: 1,
        signature: surface.signature || null,
        metadata,
      });
    }
  }

  _removeStaleSurfaces(subprojectId, previousSurfaces, currentSurfaces) {
    if (!Array.isArray(previousSurfaces) || previousSurfaces.length === 0) return;
    if (!this.store.getNodesByFile || !this.store.deleteNode || !this.store.updateNodeMetadata) return;

    const currentKeys = new Set(currentSurfaces.map(surface => surfaceKey(surface)));
    for (const previous of previousSurfaces) {
      if (currentKeys.has(surfaceKey(previous))) continue;
      const { startLine } = surfaceLines(previous);
      const node = this.store.getNodesByFile(subprojectId, previous.path)
        .find(candidate => candidate.symbol === previous.symbol
          && candidate.kind === previous.kind
          && candidate.start_line === startLine);
      if (!node) continue;

      const metadata = parseMetadata(node.metadata);
      const remainingSources = (metadata._oracle_sources || []).filter(source => source !== 'contract');
      if (remainingSources.length > 0) {
        metadata._oracle_sources = remainingSources;
        delete metadata._contract;
        this.store.updateNodeMetadata(node.id, JSON.stringify(metadata));
      } else {
        this.store.deleteNode(node.id);
      }
    }
  }

  saveSurfacesJson(surfaces, outputPath) {
    const data = surfaces.map(s => ({
      symbol: s.symbol,
      kind: s.kind,
      path: s.path,
      lang: s.lang,
      start_line: surfaceLines(s).startLine,
      end_line: surfaceLines(s).endLine,
      signature: s.signature || null,
      metadata: s.metadata || {},
    }));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    atomicWriteFileSync(outputPath, JSON.stringify(data, null, 2));
    return data.length;
  }

  loadSurfacesJson(inputPath) {
    if (!fs.existsSync(inputPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  query(subprojectId, surfaceType) {
    return this.store.findNodes({
      subprojectId,
      kind: surfaceType,
    });
  }

  consumers(subprojectId, surfaceNodeId) {
    return this.store.getConsumers(surfaceNodeId);
  }

  producers(subprojectId, surfaceNodeId) {
    return this.store.getProducers(surfaceNodeId);
  }

  schema(subprojectId, surfaceNodeId) {
    const node = this.store.getNode(surfaceNodeId);
    if (!node) return null;
    return {
      ...node,
      metadata: node.metadata ? JSON.parse(node.metadata) : {},
    };
  }
}

export function createContractRegistry(store) {
  const registry = new ContractRegistry(store);
  registry.registerDetector(new OpenApiDetector());
  registry.registerDetector(new SymfonyRouteDetector());
  registry.registerDetector(new LaravelRouteDetector());
  registry.registerDetector(new DatabaseSchemaDetector());
  registry.registerDetector(new PrismaDetector());
  registry.registerDetector(new GraphQLDetector());
  registry.registerDetector(new ApiPlatformDetector());
  registry.registerDetector(new ProtobufDetector());
  registry.registerDetector(new KafkaTopicDetector());
  registry.registerDetector(new TypeOrmDetector());
  registry.registerDetector(new DoctrineMigrationDetector());
  registry.registerDetector(new EventBusDetector());
  return registry;
}

function surfaceKey(surface) {
  return [surface.path, surface.symbol, surface.kind, surfaceLines(surface).startLine].join('\0');
}

// Lines are 1-based. File-level surfaces (e.g. an OpenAPI document) carry no
// line, and most detectors report only a start line.
function surfaceLines(surface) {
  const startLine = surface.startLine ?? surface.start_line ?? 1;
  const endLine = surface.endLine ?? surface.end_line ?? startLine;
  return { startLine, endLine: Math.max(endLine, startLine) };
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return { ...metadata };
  try { return JSON.parse(metadata); } catch { return {}; }
}

function mergeSurfaces(previous, detected) {
  const merged = new Map();
  for (const surface of [...(previous || []), ...detected]) merged.set(surfaceKey(surface), surface);
  return [...merged.values()];
}
