import type { Language } from './api';

/**
 * Starter templates. These mirror the web UI's `getStarterCode`, with trailing
 * whitespace stripped, so a file produced here and a file produced there differ
 * only cosmetically and reloading never produces a spurious diff.
 */
export function starterCode(language: Language): string {
  if (language === 'cpp') {
    return `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(NULL);

    // Write your C++ code here

    return 0;
}
`;
  }
  return `# Write your Python code here
`;
}

export function languageFromFileName(fileName: string): Language | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.py')) {
    return 'python';
  }
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.c')) {
    return 'cpp';
  }
  return undefined;
}

export function extensionFor(language: Language): string {
  return language === 'cpp' ? '.cpp' : '.py';
}