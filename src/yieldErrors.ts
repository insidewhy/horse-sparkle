/**
 * A useful helper function for building a WorkIterator for consumption by `WorkQueue`.
 * It calls the callback on each `next()` call until it does not throw, yielding each
 * thrown value.
 *
 * @example
 * async function* doSomeWork() {
 *   yield* yieldErrors((): Promise<void> => thisMayThrow());
 *   yield* yieldErrors((): Promise<void> => thisMayAlsoThrow());
 * }
 */
export async function* yieldErrors<T>(
  callback: () => Promise<T>,
): AsyncGenerator<Error | undefined, T, void> {
  for (;;) {
    try {
      return await callback()
    } catch (e) {
      yield e as Error
    }
  }
}
