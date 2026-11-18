import { describe, expect, it } from 'vitest';
import {
  createTrackedExecutionContext,
  waitForTrackedExecutionContexts,
} from './execution-contexts';

describe('tracked Worker execution contexts', () => {
  it('drains all contexts before reporting a rejected background task', async () => {
    const failedContext = createTrackedExecutionContext();
    const parentContext = createTrackedExecutionContext();
    let nestedContextFinished = false;

    failedContext.waitUntil(Promise.reject(new Error('background task failed')));
    parentContext.waitUntil(
      Promise.resolve().then(() => {
        const nestedContext = createTrackedExecutionContext();
        nestedContext.waitUntil(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              nestedContextFinished = true;
              resolve();
            }, 0);
          })
        );
      })
    );

    await expect(waitForTrackedExecutionContexts()).rejects.toThrow(
      'One or more background Worker execution contexts failed'
    );
    expect(nestedContextFinished).toBe(true);
    await expect(waitForTrackedExecutionContexts()).resolves.toBeUndefined();
  });
});
