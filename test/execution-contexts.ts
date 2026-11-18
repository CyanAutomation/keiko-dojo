import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';

type TrackedExecutionContext = ReturnType<typeof createExecutionContext>;

const pendingContexts = new Set<TrackedExecutionContext>();

export function createTrackedExecutionContext(): TrackedExecutionContext {
  const context = createExecutionContext();
  pendingContexts.add(context);
  return context;
}

export async function waitForTrackedExecutionContexts(): Promise<void> {
  const failures: unknown[] = [];

  while (pendingContexts.size > 0) {
    const contexts = [...pendingContexts];
    contexts.forEach((context) => pendingContexts.delete(context));
    const results = await Promise.allSettled(
      contexts.map(waitOnExecutionContext)
    );
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more background Worker execution contexts failed'
    );
  }
}
