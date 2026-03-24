import { expect } from 'vitest';
import { scanFile, ComponentRegistry } from './registry';

export function buildRegistry(files: Record<string, string>): ComponentRegistry {
  const registry: ComponentRegistry = new Map();
  for (const [fileName, code] of Object.entries(files)) {
    for (const entry of scanFile(code, fileName)) {
      registry.set(entry.className, entry);
    }
  }
  return registry;
}

export function expectCompiles(result: string) {
  expect(result).toBeTruthy();
  expect(result).not.toMatch(/^Error:/m);
}
