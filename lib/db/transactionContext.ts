import { AsyncLocalStorage } from 'node:async_hooks';

const transactionContext = new AsyncLocalStorage<unknown>();

export function currentTransaction<Executor>(): Executor | undefined {
  return transactionContext.getStore() as Executor | undefined;
}

export function runInTransaction<Executor, Result>(
  executor: Executor,
  callback: () => Promise<Result>,
): Promise<Result> {
  return transactionContext.run(executor, callback);
}
