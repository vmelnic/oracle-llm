import fs from 'fs';
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
  }

  registerDetector(detector) {
    this.detectors.push(detector);
  }

  async scan(subproject) {
    const surfaces = [];
    for (const detector of this.detectors) {
      try {
        const found = await detector.detect(subproject);
        surfaces.push(...found);
      } catch {
        // detector failed for this subproject — skip
      }
    }
    return surfaces;
  }

  async index(subproject) {
    const surfaces = await this.scan(subproject);
    for (const surface of surfaces) {
      this.store.upsertNode({
        subproject_id: subproject.id,
        path: surface.path,
        lang: surface.lang || subproject.language,
        symbol: surface.symbol,
        kind: surface.kind,
        start_line: surface.startLine || 0,
        end_line: surface.endLine || 0,
        exported: 1,
        signature: surface.signature || null,
        metadata: surface.metadata || {},
      });
    }
    return { surfacesIndexed: surfaces.length, surfaces };
  }

  saveSurfacesJson(surfaces, outputPath) {
    const data = surfaces.map(s => ({
      symbol: s.symbol,
      kind: s.kind,
      path: s.path,
      lang: s.lang,
      start_line: s.startLine || 0,
      end_line: s.endLine || 0,
      signature: s.signature || null,
      metadata: s.metadata || {},
    }));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
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
