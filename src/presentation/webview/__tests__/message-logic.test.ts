import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const htmlPath = path.join(__dirname, '..', 'minimal-panel.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

function extractStructuredBlock(
  source: string,
  startMarker: string,
  openingChar: '{' | '[',
  closingChar: '}' | ']'
) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Failed to locate start marker: ${startMarker}`);
  }
  const openIndex = source.indexOf(openingChar, startIndex);
  if (openIndex === -1) {
    throw new Error(`Failed to find opening char for marker: ${startMarker}`);
  }
  let depth = 0;
  let endIndex = openIndex;
  for (; endIndex < source.length; endIndex++) {
    const ch = source[endIndex];
    if (ch === openingChar) {
      depth += 1;
    } else if (ch === closingChar) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`Failed to extract balanced block for marker: ${startMarker}`);
  }
  const block = source.slice(startIndex, endIndex + 1);
  const trailing = source[endIndex + 1] === ';' ? ';' : '';
  return block + trailing;
}

function extractFunction(source: string, functionStart: string) {
  const startIndex = source.indexOf(functionStart);
  if (startIndex === -1) {
    throw new Error(`Failed to find function ${functionStart}`);
  }
  const openIndex = source.indexOf('{', startIndex);
  if (openIndex === -1) {
    throw new Error(`Failed to find function body for ${functionStart}`);
  }
  let depth = 0;
  let endIndex = openIndex;
  for (; endIndex < source.length; endIndex++) {
    const ch = source[endIndex];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces for function ${functionStart}`);
  }
  return source.slice(startIndex, endIndex + 1);
}

const messageKeywordsSnippet = extractStructuredBlock(
  htmlContent,
  'const MESSAGE_TYPE_KEYWORDS =',
  '{',
  '}'
);
const messageTemplatesSnippet = extractStructuredBlock(
  htmlContent,
  'const MESSAGE_TEMPLATES =',
  '[',
  ']'
);
const inferFunctionSnippet = extractFunction(htmlContent, 'function inferMessageTypeFromContent');

const sandboxSource = `
${messageKeywordsSnippet}
${messageTemplatesSnippet}
${inferFunctionSnippet}
module.exports = {
  MESSAGE_TYPE_KEYWORDS,
  MESSAGE_TEMPLATES,
  inferMessageTypeFromContent
};
`;

const sandboxModule: { exports: any } = { exports: {} };
vm.runInNewContext(sandboxSource, { module: sandboxModule });
const {
  MESSAGE_TYPE_KEYWORDS,
  MESSAGE_TEMPLATES,
  inferMessageTypeFromContent
} = sandboxModule.exports as {
  MESSAGE_TYPE_KEYWORDS: Record<string, string[]>;
  MESSAGE_TEMPLATES: Array<{ id: string; stage: string | null; type: string; label: string; content: string; }>;
  inferMessageTypeFromContent: (value: string) => string | null;
};

describe('message logic extracted from minimal-panel', () => {
  it('contains expected keyword classifications', () => {
    expect(MESSAGE_TYPE_KEYWORDS.requirement?.length).toBeGreaterThan(0);
    expect(MESSAGE_TYPE_KEYWORDS.question).toContain('?');
  });

  it('infers requirement messages based on keywords', () => {
    expect(inferMessageTypeFromContent('请帮我实现一个新功能')).toBe('requirement');
    expect(inferMessageTypeFromContent('接下来应该怎么做？')).toBe('question');
    expect(inferMessageTypeFromContent('这里有告警日志')).toBe('warning');
  });

  it('exposes stage-specific templates', () => {
    const clarifyTemplates = MESSAGE_TEMPLATES.filter(template => template.stage === 'clarify');
    expect(clarifyTemplates.length).toBeGreaterThan(0);
    expect(clarifyTemplates[0].type).toBeTruthy();
  });
});
