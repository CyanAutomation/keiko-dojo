import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';

type TrackedExecutionContext = ReturnType<typeof createExecutionContext>;

const pendingContexts = new Set<TrackedExecutionContext>();

export function createTrackedExecutionContext(): TrackedExecutionContext {
  const context = createExecutionContext();
  pendingContexts.add(context);
  return context;
}

export async function waitForTrackedExecutionContexts(): Promise<void> {
  while (pendingContexts.size > 0) {
    const contexts = [...pendingContexts];
    contexts.forEach((context) => pendingContexts.delete(context));
    await Promise.all(contexts.map(waitOnExecutionContext));
  }
}
