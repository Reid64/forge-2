// FORGE 2.0 — SCAN Operations 1-4
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';
import type { FileTreeResult, DependencyGraph, BrokenImport, ImportEdge } from './types.js';

const EXCLUDE = /node_modules|\.next|\.git|dist|build|\.cache/;

export function scanDirectoryTree(projectPath: string): FileTreeResult {
  const files: FileTreeResult['files'] = [];
  function walk(dir: string): void {
    let entries: string[]; try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const fp = join(dir, e); if (EXCLUDE.test(fp)) continue;
      let s; try { s = statSync(fp); } catch { continue; }
      if (s.isDirectory()) { walk(fp); continue; }
      files.push({ fullPath: fp, extension: extname(e) || '(none)', sizeBytes: s.size, lastModified: s.mtime });
    }
  }
  walk(projectPath);
  const byExtension: FileTreeResult['byExtension'] = {};
  let totalBytes = 0;
  for (const f of files) {
    if (!byExtension[f.extension]) byExtension[f.extension] = { count: 0, totalSizeKB: 0 };
    byExtension[f.extension].count++; byExtension[f.extension].totalSizeKB += f.sizeBytes / 1024; totalBytes += f.sizeBytes;
  }
  return { totalFiles: files.length, byExtension, files, projectSizeKB: totalBytes / 1024 };
}

const IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const NAMED_EXPORT_RE = /export\s+(?:const|function|class|type|interface|enum|let|var)\s+(\w+)/g;

function getExports(fp: string): string[] {
  let c = ''; try { c = readFileSync(fp, 'utf8'); } catch { return []; }
  const ex: string[] = [];
  if (/export\s+default\s+/.test(c)) ex.push('default');
  NAMED_EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_EXPORT_RE.exec(c)) !== null) ex.push(m[1]);
  return ex;
}

function resolveImp(fromFile: string, imp: string): string | null {
  if (!imp.startsWith('.') && !imp.startsWith('/')) return null;
  const base = resolve(dirname(fromFile), imp);
  for (const c of [base, base+'.ts', base+'.tsx', base+'.js', base+'/index.ts', base+'/index.tsx', base.replace(/\.js$/,'.ts'), base.replace(/\.js$/,'.tsx')]) if (existsSync(c)) return c;
  return null;
}

export function buildDependencyGraph(projectPath: string): DependencyGraph {
  const graph: DependencyGraph = { nodes: new Map(), edges: [] };
  function walk(dir: string): void {
    let entries: string[]; try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const fp = join(dir, e); if (EXCLUDE.test(fp)) continue;
      let s; try { s = statSync(fp); } catch { continue; }
      if (s.isDirectory()) { walk(fp); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(e)) continue;
      let content = ''; try { content = readFileSync(fp, 'utf8'); } catch { continue; }
      if (!graph.nodes.has(fp)) graph.nodes.set(fp, { exports: getExports(fp), importCount: 0, dependencyCount: 0 });
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(content)) !== null) {
        const imp = m[1] || m[2]; if (!imp) continue;
        const resolved = resolveImp(fp, imp);
        graph.edges.push({ source: fp, target: imp, importedNames: [], isRelative: imp.startsWith('.'), resolvedTarget: resolved });
        const node = graph.nodes.get(fp); if (node) node.dependencyCount++;
        if (resolved && graph.nodes.has(resolved)) { const tn = graph.nodes.get(resolved)!; tn.importCount++; }
      }
    }
  }
  walk(projectPath);
  return graph;
}

export function detectBrokenImports(graph: DependencyGraph, projectPath: string): BrokenImport[] {
  const broken: BrokenImport[] = [];
  for (const edge of graph.edges) {
    if (!edge.isRelative) continue;
    if (!edge.resolvedTarget) {
      broken.push({ sourceFile: relative(projectPath, edge.source), importPath: edge.target, resolvedPath: null, severity: 'CRITICAL' });
    } else if (edge.importedNames.length > 0) {
      const exports = graph.nodes.get(edge.resolvedTarget)?.exports ?? getExports(edge.resolvedTarget);
      for (const name of edge.importedNames) {
        if (name !== 'default' && !exports.includes(name)) broken.push({ sourceFile: relative(projectPath, edge.source), importPath: edge.target, resolvedPath: relative(projectPath, edge.resolvedTarget), missingExport: name, severity: 'CRITICAL' });
      }
    }
  }
  return broken;
}

const ENTRY_RE = /page\.(tsx?|jsx?)$|route\.(ts|js)$|layout\.tsx?$|middleware\.(ts|js)$|tailwind\.config|next\.config|tsconfig|vitest\.config|jest\.config|playwright\.config/;

export function detectDeadFiles(graph: DependencyGraph, projectPath: string): string[] {
  const imported = new Set(graph.edges.filter(e => e.resolvedTarget).map(e => e.resolvedTarget!));
  return [...graph.nodes.keys()].filter(fp => !imported.has(fp) && !ENTRY_RE.test(fp)).map(fp => relative(projectPath, fp));
}
