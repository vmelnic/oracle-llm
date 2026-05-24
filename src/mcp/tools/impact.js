export function impact(ctx, { change }) {
  const { store, subproject, manifest } = ctx;

  if (!change) {
    return {
      answer: {
        breaking: false,
        affected_subprojects: [],
        affected_routes: [],
        affected_components: [],
        hardcoded_checks: [],
        migration_needed: false,
        next_migration_number: null,
        recommendation: 'No change description provided.',
      },
      evidence: [],
      layer: 'L1',
    };
  }

  const subId = subproject?.id ?? subproject;
  const tokens = parseChangeDescription(change);
  const seedNodes = findSeedNodes(store, subId, tokens);
  const seedIds = seedNodes.map((n) => n.id);

  let affected = [];
  if (seedIds.length > 0) {
    affected = store.impact(subId, seedIds);
  }

  const allAffected = [...seedNodes, ...affected];

  const affectedRoutes = allAffected
    .filter((n) => n.kind === 'route' || n.kind === 'api_endpoint')
    .map((n) => ({
      symbol: n.symbol,
      path: n.path,
      line: n.start_line,
      depth: n.depth ?? 0,
    }));

  const affectedComponents = allAffected
    .filter((n) => n.kind === 'component')
    .map((n) => ({
      symbol: n.symbol,
      path: n.path,
      line: n.start_line,
      depth: n.depth ?? 0,
    }));

  const affectedSubprojects = [
    ...new Set(allAffected.map((n) => n.subproject_id).filter(Boolean)),
  ];

  const hardcodedChecks = findHardcodedChecks(allAffected, tokens);

  const involvesDb = seedNodes.some(
    (n) => n.kind === 'db_table' || n.kind === 'migration'
  ) || tokens.tableNames.length > 0 || tokens.columnNames.length > 0;

  const migrationNeeded = involvesDb && !tokens.isReadOnly;
  let nextMigrationNumber = null;

  if (migrationNeeded && manifest?.migrations) {
    nextMigrationNumber = computeNextMigration(manifest.migrations);
  }

  const breaking = determineBreaking(seedNodes, affected, tokens);

  const recommendations = [];
  if (migrationNeeded) recommendations.push('Create a database migration before deploying.');
  if (affectedRoutes.length > 0) recommendations.push(`Update ${affectedRoutes.length} affected route(s).`);
  if (affectedComponents.length > 0) recommendations.push(`Check ${affectedComponents.length} affected component(s).`);
  if (breaking) recommendations.push('This is a breaking change — coordinate with consumers.');
  if (hardcodedChecks.length > 0) recommendations.push(`Review ${hardcodedChecks.length} hardcoded reference(s).`);

  const evidence = seedNodes.slice(0, 10).map((n) => ({
    path: n.path,
    line_range: [n.start_line, n.end_line],
    symbol: n.symbol,
    kind: n.kind,
    role: 'seed',
  }));

  for (const a of affected.slice(0, 10)) {
    evidence.push({
      path: a.path,
      line_range: [a.start_line, a.end_line],
      symbol: a.symbol,
      kind: a.kind,
      role: 'affected',
      depth: a.depth,
    });
  }

  return {
    answer: {
      breaking,
      affected_subprojects: affectedSubprojects,
      affected_routes: affectedRoutes,
      affected_components: affectedComponents,
      hardcoded_checks: hardcodedChecks,
      migration_needed: migrationNeeded,
      next_migration_number: nextMigrationNumber,
      recommendation: recommendations.join(' ') || 'No issues detected.',
      seed_nodes: seedNodes.length,
      total_affected: affected.length,
    },
    evidence,
    layer: 'L1',
  };
}

function parseChangeDescription(change) {
  const lower = change.toLowerCase();
  const words = change.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);

  const tablePatterns = [
    /(?:table|from|join|into)\s+[`"']?(\w+)[`"']?/gi,
    /(\w+)(?:_table|Table)\b/g,
  ];
  const tableNames = [];
  for (const pat of tablePatterns) {
    let m;
    while ((m = pat.exec(change)) !== null) {
      tableNames.push(m[1].toLowerCase());
    }
  }

  const columnPatterns = [
    /(?:column|field|add|drop|rename)\s+[`"']?(\w+)[`"']?/gi,
    /\.(\w+)\s*(?:=|!=|<|>|IS)/gi,
  ];
  const columnNames = [];
  for (const pat of columnPatterns) {
    let m;
    while ((m = pat.exec(change)) !== null) {
      columnNames.push(m[1].toLowerCase());
    }
  }

  const classPatterns = [
    /(?:class|model|entity|controller|service)\s+(\w+)/gi,
  ];
  const classNames = [];
  for (const pat of classPatterns) {
    let m;
    while ((m = pat.exec(change)) !== null) {
      classNames.push(m[1]);
    }
  }

  const routePatterns = [/(?:route|endpoint|path)\s+['"`]?([/\w{}:]+)['"`]?/gi];
  const routePaths = [];
  for (const pat of routePatterns) {
    let m;
    while ((m = pat.exec(change)) !== null) {
      routePaths.push(m[1]);
    }
  }

  const isReadOnly = /\b(read|select|get|fetch|query|list)\b/i.test(lower) &&
    !/\b(add|drop|alter|rename|delete|remove|create|modify|update|insert)\b/i.test(lower);

  const isRemoval = /\b(remove|drop|delete)\b/i.test(lower);
  const isRename = /\brename\b/i.test(lower);

  return {
    words,
    tableNames: [...new Set(tableNames)],
    columnNames: [...new Set(columnNames)],
    classNames: [...new Set(classNames)],
    routePaths: [...new Set(routePaths)],
    isReadOnly,
    isRemoval,
    isRename,
  };
}

function findSeedNodes(store, subId, tokens) {
  const seeds = [];
  const seenIds = new Set();

  function addUnique(nodes) {
    for (const n of nodes) {
      if (!seenIds.has(n.id)) {
        seenIds.add(n.id);
        seeds.push(n);
      }
    }
  }

  for (const table of tokens.tableNames) {
    addUnique(store.findNodes({ subprojectId: subId, kind: 'db_table' })
      .filter((n) => n.symbol.toLowerCase().includes(table)));
    addUnique(store.findNodes({ subprojectId: subId, kind: 'migration' })
      .filter((n) => {
        const meta = safeParse(n.metadata);
        return meta.table?.toLowerCase() === table;
      }));
  }

  for (const cls of tokens.classNames) {
    addUnique(store.locate(subId, cls));
  }

  for (const rp of tokens.routePaths) {
    addUnique(store.findNodes({ subprojectId: subId, kind: 'route' })
      .filter((n) => n.symbol.includes(rp)));
  }

  if (seeds.length === 0) {
    const allNodes = store.findNodes({ subprojectId: subId });
    for (const word of tokens.words) {
      if (word.length < 3) continue;
      const lower = word.toLowerCase();
      const matches = allNodes.filter(
        (n) => n.symbol.toLowerCase().includes(lower)
      );
      addUnique(matches.slice(0, 10));
    }
  }

  return seeds;
}

function findHardcodedChecks(affected, tokens) {
  const checks = [];

  for (const node of affected) {
    const meta = safeParse(node.metadata);
    const metaStr = JSON.stringify(meta).toLowerCase();

    for (const col of tokens.columnNames) {
      if (node.symbol.toLowerCase().includes(col) || metaStr.includes(col)) {
        checks.push({
          path: node.path,
          symbol: node.symbol,
          line: node.start_line,
          reference: col,
          kind: 'column_reference',
        });
      }
    }

    for (const table of tokens.tableNames) {
      if (node.symbol.toLowerCase().includes(table) || metaStr.includes(table)) {
        checks.push({
          path: node.path,
          symbol: node.symbol,
          line: node.start_line,
          reference: table,
          kind: 'table_reference',
        });
      }
    }
  }

  return deduplicateChecks(checks);
}

function determineBreaking(seedNodes, affected, tokens) {
  if (tokens.isRemoval) return true;
  if (tokens.isRename) return true;

  const hasPublicApi = seedNodes.some(
    (n) => (n.kind === 'route' || n.kind === 'api_endpoint') && n.exported
  );
  if (hasPublicApi && affected.length > 0) return true;

  if (affected.length > 20) return true;

  return false;
}

function computeNextMigration(migrations) {
  if (!migrations) return null;

  const count = migrations.count || 0;
  const naming = migrations.naming;

  if (!naming) return count + 1;

  if (naming.includes('YmdHis') || naming.includes('Y_m_d_His')) {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    if (naming.startsWith('Version')) return `Version${ts}`;
    if (naming.includes('Y_m_d')) {
      return `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }
    return ts;
  }

  return count + 1;
}

function deduplicateChecks(checks) {
  const seen = new Set();
  return checks.filter((c) => {
    const key = `${c.path}:${c.symbol}:${c.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeParse(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
