import fg from 'fast-glob';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const BUILD_MANIFESTS = [
  'package.json',
  'composer.json',
  'pyproject.toml',
  'pubspec.yaml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
];

const DEFAULT_EXCLUDE = [
  '**/vendor/**',
  '**/node_modules/**',
  '**/var/**',
  '**/dist/**',
  '**/build/**',
  '**/public/builder/**',
  '**/public/assets/**',
  '**/*.zip',
  '**/.git/**',
];

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readYaml(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readToml(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function hasDep(pkg, name) {
  if (!pkg) return false;
  const all = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  return name in all;
}

function hasComposerDep(pkg, name) {
  if (!pkg) return false;
  const all = {
    ...pkg.require,
    ...pkg['require-dev'],
  };
  return name in all;
}

function tomlContainsDep(content, depName) {
  if (!content) return false;
  return content.includes(depName);
}

function detectFramework(manifestName, manifestPath) {
  if (manifestName === 'package.json') {
    const pkg = readJson(manifestPath);
    if (hasDep(pkg, 'next')) return 'nextjs';
    if (hasDep(pkg, 'vue')) return 'vue';
    if (hasDep(pkg, 'react')) return 'react';
    if (hasDep(pkg, 'express')) return 'express';
    return null;
  }

  if (manifestName === 'composer.json') {
    const pkg = readJson(manifestPath);
    if (hasComposerDep(pkg, 'symfony/framework-bundle')) return 'symfony';
    if (hasComposerDep(pkg, 'laravel/framework')) return 'laravel';
    return null;
  }

  if (manifestName === 'pubspec.yaml') {
    const pkg = readYaml(manifestPath);
    if (pkg?.dependencies?.flutter != null) return 'flutter';
    return null;
  }

  if (manifestName === 'pyproject.toml') {
    const content = readToml(manifestPath);
    if (tomlContainsDep(content, 'django')) return 'django';
    if (tomlContainsDep(content, 'fastapi')) return 'fastapi';
    if (tomlContainsDep(content, 'flask')) return 'flask';
    return null;
  }

  if (manifestName === 'build.gradle') {
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      if (content.includes('org.springframework.boot')) return 'spring-boot';
      if (content.includes('com.android')) return 'android';
    } catch {}
    return null;
  }

  return null;
}

function detectLanguage(manifestName, manifestDir) {
  const map = {
    'package.json': () => {
      const tsconfigLocations = [
        path.join(manifestDir, 'tsconfig.json'),
        path.join(manifestDir, 'tsconfig.base.json'),
      ];
      if (tsconfigLocations.some(p => fs.existsSync(p))) return 'typescript';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(manifestDir, 'package.json'), 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps['typescript']) return 'typescript';
      } catch {}
      const subDirs = ['src', 'app', 'apps', 'packages', 'lib'];
      for (const sub of subDirs) {
        const tsPath = path.join(manifestDir, sub);
        if (fs.existsSync(tsPath) && fs.existsSync(path.join(tsPath, 'tsconfig.json'))) return 'typescript';
        try {
          const entries = fs.readdirSync(tsPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && fs.existsSync(path.join(tsPath, entry.name, 'tsconfig.json'))) return 'typescript';
          }
        } catch {}
      }
      return 'javascript';
    },
    'composer.json': () => 'php',
    'pubspec.yaml': () => 'dart',
    'pyproject.toml': () => 'python',
    'go.mod': () => 'go',
    'Cargo.toml': () => 'rust',
    'pom.xml': () => 'java',
    'build.gradle': () => 'java',
  };
  return (map[manifestName] ?? (() => 'unknown'))();
}

function defaultGlobs(language) {
  const globs = {
    typescript: {
      include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.vue'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.turbo/**'],
    },
    javascript: {
      include: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.vue'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.turbo/**'],
    },
    php: {
      include: ['**/*.php'],
      exclude: ['**/vendor/**', '**/var/**'],
    },
    dart: {
      include: ['**/*.dart'],
      exclude: ['**/.dart_tool/**', '**/build/**', '**/*.freezed.dart', '**/*.g.dart', '**/*.gen.dart', '**/*.config.dart', '**/*.gr.dart', '**/*.mocks.dart'],
    },
    python: {
      include: ['**/*.py'],
      exclude: ['**/__pycache__/**', '**/.venv/**', '**/venv/**'],
    },
    go: {
      include: ['**/*.go'],
      exclude: ['**/vendor/**'],
    },
    rust: {
      include: ['**/*.rs'],
      exclude: ['**/target/**'],
    },
    java: {
      include: ['**/*.java'],
      exclude: ['**/target/**', '**/build/**'],
    },
  };
  return globs[language] ?? { include: ['**/*'], exclude: [] };
}

function detectLspConfig(language, framework, root) {
  if (language === 'typescript' || language === 'javascript') {
    if (fs.existsSync(path.join(root, 'tsconfig.json')) || fs.existsSync(path.join(root, 'node_modules'))) {
      return {
        cmd: 'npx typescript-language-server --stdio',
        init: { },
        root_markers: ['tsconfig.json', 'package.json', 'jsconfig.json'],
      };
    }
  }

  if (language === 'php') {
    if (fs.existsSync(path.join(root, 'vendor/bin/phpstan')) || fs.existsSync(path.join(root, 'composer.json'))) {
      return {
        cmd: 'intelephense --stdio',
        init: {},
        root_markers: ['composer.json', 'phpcs.xml', 'phpstan.neon'],
      };
    }
  }

  if (language === 'dart') {
    return {
      cmd: 'dart analysis-server --stdio',
      init: {},
      root_markers: ['pubspec.yaml', 'analysis_options.yaml'],
    };
  }

  return null;
}

function isNestedUnder(candidatePath, existingPaths) {
  for (const existing of existingPaths) {
    const existingDir = path.dirname(existing);
    if (candidatePath.startsWith(existingDir + path.sep) && candidatePath !== existing) {
      const relative = path.relative(existingDir, path.dirname(candidatePath));
      if (relative && !relative.startsWith('..')) {
        return true;
      }
    }
  }
  return false;
}

export async function detectSubprojects(rootPath) {
  const absoluteRoot = fs.realpathSync(path.resolve(rootPath));

  const patterns = BUILD_MANIFESTS.map(m => `**/${m}`);
  const entries = await fg(patterns, {
    cwd: absoluteRoot,
    ignore: DEFAULT_EXCLUDE,
    absolute: false,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });

  const safeEntries = entries.filter(entry => {
    try {
      const target = fs.realpathSync(path.join(absoluteRoot, entry));
      const relative = path.relative(absoluteRoot, target);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  });

  safeEntries.sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    return depthA - depthB;
  });

  const accepted = [];

  for (const entry of safeEntries) {
    const absoluteManifest = path.join(absoluteRoot, entry);
    if (!isNestedUnder(absoluteManifest, accepted.map(a => a.absoluteManifest))) {
      accepted.push({ entry, absoluteManifest });
    }
  }

  return accepted.map(({ entry, absoluteManifest }) => {
    const manifestName = path.basename(entry);
    const manifestDir = path.dirname(absoluteManifest);
    const relativeDir = path.relative(absoluteRoot, manifestDir) || '.';
    const language = detectLanguage(manifestName, manifestDir);
    const framework = detectFramework(manifestName, absoluteManifest);
    const globs = defaultGlobs(language);

    const id = relativeDir === '.' ? 'root' : relativeDir.replace(/\\/g, '/');

    return {
      id,
      root: manifestDir,
      language,
      framework,
      buildManifest: absoluteManifest,
      includeGlobs: globs.include,
      excludeGlobs: globs.exclude,
      lsp: detectLspConfig(language, framework, manifestDir),
    };
  });
}

export async function scanWorkspace(rootPath) {
  const absoluteRoot = fs.realpathSync(path.resolve(rootPath));
  const id = sanitizeId(path.basename(absoluteRoot));
  const subprojects = await detectSubprojects(absoluteRoot);

  return {
    id,
    root: absoluteRoot,
    subprojects,
  };
}
