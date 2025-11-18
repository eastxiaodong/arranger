import * as path from 'path';

/**
 * Normalize a project path to a consistent format.
 * Supports Windows, Unix, and WSL style paths.
 */
export function normalizeProjectPath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path cannot be empty');
  }

  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    throw new Error('Path cannot be blank');
  }

  // Handle Windows UNC paths that point to WSL, e.g. \\wsl$\Ubuntu\home\user
  if (trimmedPath.startsWith('\\\\wsl$\\') || trimmedPath.startsWith('//wsl$/')) {
    const normalized = trimmedPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[0] === 'wsl$') {
      return '/' + parts.slice(2).join('/');
    }
    // Fall back to default normalization if the path is incomplete
    return path.resolve(trimmedPath).replace(/\\/g, '/');
  }

  // Unix/WSL style paths
  if (trimmedPath.startsWith('/')) {
    // Convert /mnt/c/... to Windows paths when running on Windows host
    if (process.platform === 'win32' && trimmedPath.startsWith('/mnt/')) {
      const match = trimmedPath.match(/^\/mnt\/([a-z])\/(.*)/i);
      if (match) {
        const drive = match[1].toUpperCase();
        const rest = match[2];
        return normalizeTrailingSlash(`${drive}:/${rest}`);
      }
    }
    return normalizeTrailingSlash(trimmedPath.replace(/\\/g, '/'));
  }

  // All other paths are resolved relative to current working directory
  return normalizeTrailingSlash(path.resolve(trimmedPath).replace(/\\/g, '/'));
}

function normalizeTrailingSlash(target: string): string {
  if (target.length > 1 && target.endsWith('/')) {
    return target.slice(0, -1);
  }
  if (target.length > 3 && target.endsWith('\\')) {
    return target.slice(0, -1);
  }
  return target;
}
