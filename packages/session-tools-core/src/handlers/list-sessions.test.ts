import { describe, it, expect } from 'bun:test';
import { handleListSessions } from './list-sessions.ts';
import type { ListSessionsOptions, SessionToolContext } from '../context.ts';

function createCtx(): { ctx: SessionToolContext; calls: ListSessionsOptions[] } {
  const calls: ListSessionsOptions[] = [];
  const ctx = {
    sessionId: 'sess-1',
    listSessions: (options?: ListSessionsOptions) => {
      calls.push(options ?? {});
      return {
        total: 1,
        returned: 1,
        sessions: [
          {
            id: 'target-1',
            name: 'Dida worker',
            labels: ['员工'],
            status: 'todo',
            createdAt: 123,
            projectId: 'proj-info',
            employeeId: 'emp_dida_manager',
            employeeSlug: 'dida-manager',
            employeeName: '滴答管家',
          },
        ],
      };
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleListSessions', () => {
  it('passes employee filters through to the context callback', async () => {
    const { ctx, calls } = createCtx();
    const res = await handleListSessions(ctx, {
      employeeId: 'emp_dida_manager',
      employeeSlug: 'dida-manager',
      employeeName: '滴答',
      sortBy: 'employee',
      limit: 10,
    });

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        employeeId: 'emp_dida_manager',
        employeeSlug: 'dida-manager',
        employeeName: '滴答',
        sortBy: 'employee',
        limit: 10,
        offset: undefined,
        label: undefined,
        search: undefined,
        status: undefined,
      },
    ]);
  });

  it('returns employee metadata in list results', async () => {
    const { ctx } = createCtx();
    const res = await handleListSessions(ctx, {});
    const text = JSON.stringify(res);

    expect(res.isError).toBeFalsy();
    expect(text).toContain('emp_dida_manager');
    expect(text).toContain('dida-manager');
    expect(text).toContain('滴答管家');
  });
});
