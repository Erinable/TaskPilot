// A note in the notes list, as notes:list serves it (no body).
import type * as noteTypes from '@shared/ipc/notes.ts';

export const noteMeta = (overrides: Partial<noteTypes.NoteMeta> = {}): noteTypes.NoteMeta => ({
  id: '用例要有断言.md',
  title: '用例要有断言',
  category: 'writing',
  course: null,
  concepts: [],
  tags: ['测试'],
  inlineTags: [],
  source: { repositoryId: 'r1', repositoryName: 'app', packageId: 'p1', packageTitle: '登录', file: 'src/a.ts', line: 4 },
  summary: null,
  summaryStale: false,
  links: [],
  excerpt: '没有 expect',
  createdAt: '2026-10-20T02:00:00Z',
  updatedAt: '2026-10-24T02:00:00Z',
  version: 'v1',
  frontmatterError: false,
  ...overrides,
});
