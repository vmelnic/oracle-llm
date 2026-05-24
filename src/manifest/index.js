import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import fg from 'fast-glob';

export class ManifestDrafter {
  async draft(subproject) {
    const manifest = {
      subproject: subproject.id,
      framework: subproject.framework || 'unknown',
      language: subproject.language,
      version: await detectVersion(subproject),
      conventions: await detectConventions(subproject),
      migrations: await detectMigrations(subproject),
      test_frameworks: await detectTestFrameworks(subproject),
      entry_points: await detectEntryPoints(subproject),
      build: await detectBuildConfig(subproject),
      lsp: subproject.lsp || null,
    };
    return manifest;
  }

  async save(manifest, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, yaml.dump(manifest, { lineWidth: 120, noRefs: true }));
  }

  load(manifestPath) {
    if (!fs.existsSync(manifestPath)) return null;
    return yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
  }

  merge(existing, drafted) {
    const merged = { ...drafted };
    for (const [key, value] of Object.entries(existing)) {
      if (value !== null && value !== undefined) {
        if (typeof value === 'object' && !Array.isArray(value) && typeof merged[key] === 'object') {
          merged[key] = { ...merged[key], ...value };
        } else {
          merged[key] = value;
        }
      }
    }
    return merged;
  }
}

async function detectVersion(subproject) {
  const { root, framework } = subproject;

  if (framework === 'symfony' || framework === 'laravel') {
    const composerPath = path.join(root, 'composer.json');
    if (fs.existsSync(composerPath)) {
      try {
        const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
        const req = composer.require || {};
        if (framework === 'symfony') {
          const v = req['symfony/framework-bundle'] || req['symfony/symfony'];
          if (v) return cleanVersion(v);
        }
        if (framework === 'laravel') {
          const v = req['laravel/framework'];
          if (v) return cleanVersion(v);
        }
      } catch {}
    }
  }

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (framework === 'nextjs' && deps.next) return cleanVersion(deps.next);
      if (framework === 'vue' && deps.vue) return cleanVersion(deps.vue);
      if (framework === 'react' && deps.react) return cleanVersion(deps.react);
      if (framework === 'express' && deps.express) return cleanVersion(deps.express);
    } catch {}
  }

  const pubspecPath = path.join(root, 'pubspec.yaml');
  if (fs.existsSync(pubspecPath)) {
    try {
      const pubspec = yaml.load(fs.readFileSync(pubspecPath, 'utf-8'));
      const deps = pubspec.dependencies || {};
      if (deps.flutter && deps.flutter.sdk) return 'flutter';
    } catch {}
  }

  return null;
}

function cleanVersion(v) {
  if (!v) return null;
  return v.replace(/^[\^~>=<*]+/, '').split(' ')[0];
}

async function detectConventions(subproject) {
  const conventions = {};
  const { root, framework, language } = subproject;

  if (framework === 'symfony' || framework === 'laravel') {
    await detectPhpConventions(root, framework, conventions);
  }

  if (['javascript', 'typescript'].includes(language)) {
    await detectJsConventions(root, framework, conventions);
  }

  if (language === 'dart') {
    await detectDartConventions(root, conventions);
  }

  try {
    const { extractConventionsFromFiles } = await import('../markdown/index.js');
    const docConventions = extractConventionsFromFiles(root);
    if (docConventions) {
      conventions._from_docs = docConventions;
    }
  } catch {}

  return conventions;
}

async function detectPhpConventions(root, framework, conventions) {
  if (framework === 'symfony') {
    const securityPath = path.join(root, 'config/packages/security.yaml');
    if (fs.existsSync(securityPath)) {
      try {
        const security = yaml.load(fs.readFileSync(securityPath, 'utf-8'));
        if (security?.security?.role_hierarchy) {
          conventions.role_hierarchy = security.security.role_hierarchy;
        }
        if (security?.security?.firewalls) {
          conventions.firewalls = Object.keys(security.security.firewalls);
        }
      } catch {}
    }

    conventions.routes_auto_load = fs.existsSync(
      path.join(root, 'config/routes/attributes.yaml')
    ) || fs.existsSync(path.join(root, 'config/routes/annotations.yaml'));
  }

  if (framework === 'laravel') {
    const authPath = path.join(root, 'config/auth.php');
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, 'utf-8');
      const guards = content.match(/'guards'\s*=>\s*\[([^\]]+)\]/s);
      if (guards) {
        const guardNames = guards[1].match(/'(\w+)'\s*=>/g);
        if (guardNames) {
          conventions.auth_guards = guardNames.map(g => g.match(/'(\w+)'/)[1]);
        }
      }
    }
  }

  const srcFiles = await fg(['src/**/*.php', 'app/**/*.php'], {
    cwd: root, absolute: true, stats: false,
  });
  const sample = srcFiles.slice(0, 10);
  let softDeleteCount = 0;
  let tryCatchCount = 0;
  for (const f of sample) {
    const content = fs.readFileSync(f, 'utf-8');
    if (content.includes('SoftDeletes') || content.includes('deleted_at')) softDeleteCount++;
    if (content.includes('try {')) tryCatchCount++;
  }
  if (softDeleteCount > sample.length * 0.3) {
    conventions.soft_delete = 'filter(deleted_at: null)';
  }
  if (tryCatchCount > sample.length * 0.5) {
    conventions.errors = 'try/catch pattern';
  }

  await detectAuthTokens(root, framework, conventions);
  await detectPasswordConvention(root, framework, conventions);
  await detectEmailHandling(root, framework, conventions);
}

async function detectJsConventions(root, framework, conventions) {
  const eslintFiles = await fg(['.eslintrc*', 'eslint.config.*'], { cwd: root });
  if (eslintFiles.length > 0) conventions.linter = 'eslint';

  const prettierFiles = await fg(['.prettierrc*', 'prettier.config.*'], { cwd: root });
  if (prettierFiles.length > 0) conventions.formatter = 'prettier';

  if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
    conventions.typescript = true;
  }

  if (framework === 'vue') {
    const srcFiles = await fg(['src/**/*.vue'], { cwd: root, absolute: true });
    const sample = srcFiles.slice(0, 10);
    let compositionCount = 0;
    for (const f of sample) {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('<script setup') || content.includes('defineComponent')) {
        compositionCount++;
      }
    }
    conventions.vue_api = compositionCount > sample.length * 0.5 ? 'composition' : 'options';

    const storeFiles = await fg(['src/stores/**/*', 'src/store/**/*'], { cwd: root });
    if (storeFiles.some(f => f.includes('pinia') || f.includes('defineStore'))) {
      conventions.state_management = 'pinia';
    } else if (storeFiles.length > 0) {
      conventions.state_management = 'vuex';
    }
  }

  if (framework === 'react' || framework === 'nextjs') {
    const srcFiles = await fg(['src/**/*.{jsx,tsx}', 'app/**/*.{jsx,tsx}', 'pages/**/*.{jsx,tsx}'], {
      cwd: root, absolute: true,
    });
    const sample = srcFiles.slice(0, 10);
    let hooksCount = 0;
    for (const f of sample) {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('useState') || content.includes('useEffect')) hooksCount++;
    }
    if (hooksCount > 0) conventions.react_style = 'hooks';

    if (framework === 'nextjs') {
      conventions.nextjs_router = fs.existsSync(path.join(root, 'app'))
        ? 'app-router'
        : 'pages-router';
    }
  }
}

async function detectDartConventions(root, conventions) {
  const srcFiles = await fg(['lib/**/*.dart'], { cwd: root, absolute: true });
  const sample = srcFiles.slice(0, 15);

  let riverpodCount = 0;
  let blocCount = 0;
  let getxCount = 0;
  let providerCount = 0;

  for (const f of sample) {
    const content = fs.readFileSync(f, 'utf-8');
    if (content.includes('flutter_riverpod') || content.includes('riverpod')) riverpodCount++;
    if (content.includes('flutter_bloc') || content.includes('BlocProvider')) blocCount++;
    if (content.includes('get:') || content.includes('GetxController')) getxCount++;
    if (content.includes('ChangeNotifierProvider')) providerCount++;
  }

  if (riverpodCount > 0) conventions.state_management = 'riverpod';
  else if (blocCount > 0) conventions.state_management = 'bloc';
  else if (getxCount > 0) conventions.state_management = 'getx';
  else if (providerCount > 0) conventions.state_management = 'provider';

  const goRouterFiles = await fg(['lib/**/*.dart'], {
    cwd: root, absolute: true,
  });
  for (const f of goRouterFiles.slice(0, 20)) {
    const content = fs.readFileSync(f, 'utf-8');
    if (content.includes('GoRouter') || content.includes('go_router')) {
      conventions.routing = 'go_router';
      break;
    }
  }
}

async function detectMigrations(subproject) {
  const { root, framework } = subproject;
  const migrations = {};

  const patterns = {
    symfony: ['migrations/*.php', 'src/Migrations/*.php'],
    laravel: ['database/migrations/*.php'],
    default: [
      'migrations/**/*.{sql,js,ts,php,py}',
      'prisma/migrations/**/*.sql',
      'alembic/versions/**/*.py',
    ],
  };

  const globs = patterns[framework] || patterns.default;
  const files = await fg(globs, { cwd: root });

  if (files.length > 0) {
    migrations.dir = path.dirname(files[0]);
    migrations.count = files.length;

    if (files.length >= 2) {
      const basenames = files.map(f => path.basename(f));
      if (basenames.every(b => /^Version\d{14}/.test(b))) {
        migrations.naming = 'Version{YmdHis}.php';
      } else if (basenames.every(b => /^\d{4}_\d{2}_\d{2}/.test(b))) {
        migrations.naming = '{Y_m_d_His}_name.php';
      } else if (basenames.every(b => /^\d{14}/.test(b))) {
        migrations.naming = '{YmdHis}_name';
      }
    }
  }
  return Object.keys(migrations).length > 0 ? migrations : null;
}

async function detectTestFrameworks(subproject) {
  const { root } = subproject;
  const frameworks = [];

  if (fs.existsSync(path.join(root, 'phpunit.xml')) || fs.existsSync(path.join(root, 'phpunit.xml.dist'))) {
    frameworks.push('phpunit');
  }
  if (fs.existsSync(path.join(root, 'jest.config.js')) || fs.existsSync(path.join(root, 'jest.config.ts'))) {
    frameworks.push('jest');
  }
  if (fs.existsSync(path.join(root, 'vitest.config.js')) || fs.existsSync(path.join(root, 'vitest.config.ts'))) {
    frameworks.push('vitest');
  }
  if (fs.existsSync(path.join(root, 'playwright.config.js')) || fs.existsSync(path.join(root, 'playwright.config.ts'))) {
    frameworks.push('playwright');
  }
  if (fs.existsSync(path.join(root, 'cypress.config.js')) || fs.existsSync(path.join(root, 'cypress.config.ts'))) {
    frameworks.push('cypress');
  }

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.mocha && !frameworks.includes('mocha')) frameworks.push('mocha');
      if (allDeps.ava && !frameworks.includes('ava')) frameworks.push('ava');
    } catch {}
  }

  const pubspecPath = path.join(root, 'pubspec.yaml');
  if (fs.existsSync(pubspecPath)) {
    try {
      const pubspec = yaml.load(fs.readFileSync(pubspecPath, 'utf-8'));
      const devDeps = pubspec.dev_dependencies || {};
      if (devDeps.flutter_test || devDeps.test) frameworks.push('flutter_test');
      if (devDeps.mockito) frameworks.push('mockito');
    } catch {}
  }

  return frameworks.length > 0 ? frameworks : null;
}

async function detectEntryPoints(subproject) {
  const { root, framework, language } = subproject;
  const entries = [];

  const candidates = {
    nextjs: ['pages/_app.js', 'pages/_app.tsx', 'app/layout.js', 'app/layout.tsx'],
    vue: ['src/main.js', 'src/main.ts', 'src/App.vue'],
    react: ['src/index.js', 'src/index.tsx', 'src/App.js', 'src/App.tsx'],
    express: ['index.js', 'src/index.js', 'src/app.js', 'server.js', 'app.js'],
    symfony: ['public/index.php', 'bin/console'],
    laravel: ['public/index.php', 'artisan'],
    flutter: ['lib/main.dart'],
  };

  const frameworkCandidates = candidates[framework] || [];
  for (const c of frameworkCandidates) {
    if (fs.existsSync(path.join(root, c))) entries.push(c);
  }

  if (entries.length === 0) {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.main) entries.push(pkg.main);
      } catch {}
    }
  }

  return entries.length > 0 ? entries : null;
}

async function detectBuildConfig(subproject) {
  const { root } = subproject;
  const build = {};

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        if (pkg.scripts.build) build.command = pkg.scripts.build;
        if (pkg.scripts.dev) build.dev_command = pkg.scripts.dev;
      }
    } catch {}
  }

  if (fs.existsSync(path.join(root, 'vite.config.js')) || fs.existsSync(path.join(root, 'vite.config.ts'))) {
    build.bundler = 'vite';
  } else if (fs.existsSync(path.join(root, 'webpack.config.js'))) {
    build.bundler = 'webpack';
  }

  return Object.keys(build).length > 0 ? build : null;
}

async function detectAuthTokens(root, framework, conventions) {
  const authTokenPatterns = [];

  const envFiles = await fg(['.env.example', '.env.local.example', '.env'], { cwd: root, absolute: true });
  for (const f of envFiles) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      const tokenMatches = content.matchAll(/([\w_]*TOKEN[\w_]*)\s*=/gi);
      for (const m of tokenMatches) {
        const name = m[1];
        const contextMatch = content.slice(Math.max(0, m.index - 80), m.index).match(/#\s*(\w[\w\s-]*)/);
        authTokenPatterns.push({
          name,
          context: contextMatch ? contextMatch[1].trim() : '',
        });
      }
    } catch {}
  }

  const securityFiles = await fg([
    'config/packages/security.yaml',
    'config/auth.php',
    'config/sanctum.php',
    'config/jwt.php',
  ], { cwd: root, absolute: true });

  for (const f of securityFiles) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('bearer') || content.includes('jwt') || content.includes('JWT')) {
        authTokenPatterns.push({ name: 'Authorization', context: 'Bearer/JWT header' });
      }
      if (content.includes('cookie') && content.includes('token')) {
        authTokenPatterns.push({ name: 'cookie_token', context: 'cookie-based auth' });
      }
    } catch {}
  }

  if (framework === 'laravel') {
    const sanctumPath = path.join(root, 'config/sanctum.php');
    if (fs.existsSync(sanctumPath)) {
      authTokenPatterns.push({ name: 'sanctum_token', context: 'Laravel Sanctum' });
    }
    const passportPath = path.join(root, 'config/passport.php');
    if (fs.existsSync(passportPath)) {
      authTokenPatterns.push({ name: 'passport_token', context: 'Laravel Passport' });
    }
  }

  if (authTokenPatterns.length > 0) {
    const grouped = {};
    for (const t of authTokenPatterns) {
      if (!grouped[t.context || t.name]) grouped[t.context || t.name] = t.name;
    }
    conventions.auth_tokens = grouped;
  }
}

async function detectPasswordConvention(root, framework, conventions) {
  const srcFiles = await fg(['src/**/*.php', 'app/**/*.php'], {
    cwd: root, absolute: true,
  });

  let hashedCount = 0;
  let plaintextCount = 0;
  let total = 0;

  for (const f of srcFiles.slice(0, 50)) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (!content.includes('password') && !content.includes('Password')) continue;
      total++;
      if (content.includes('bcrypt') || content.includes('hash(') || content.includes('Hash::')
        || content.includes('password_hash') || content.includes('password_hash(')
        || content.includes('argon2') || content.includes('Argon2')) {
        hashedCount++;
      }
      if (content.includes('plain') || content.includes('plaintext')
        || (content.includes('$request->password') && !content.includes('hash'))) {
        plaintextCount++;
      }
    } catch {}
  }

  if (total === 0) return;

  if (hashedCount > total * 0.5) {
    conventions.password = 'server-side hashing (bcrypt/argon2)';
  } else if (plaintextCount > total * 0.3) {
    conventions.password = 'client sends plaintext, server hashes';
  }
}

async function detectEmailHandling(root, framework, conventions) {
  const srcFiles = await fg(['src/**/*.php', 'app/**/*.php', 'src/**/*.{ts,js}'], {
    cwd: root, absolute: true,
  });

  let lowercaseCount = 0;
  let total = 0;

  for (const f of srcFiles.slice(0, 50)) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (!content.includes('email') && !content.includes('Email') && !content.includes('mail')) continue;
      total++;
      if (content.includes('strtolower') || content.includes('toLowerCase()')
        || content.includes('.lower()') || content.includes('mb_strtolower')) {
        lowercaseCount++;
      }
    } catch {}
  }

  if (total > 0 && lowercaseCount > total * 0.3) {
    conventions.email_handling = 'lowercase-before-store';
  }
}
