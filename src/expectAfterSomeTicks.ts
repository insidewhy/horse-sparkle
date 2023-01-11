// need a limit to avoid an infinite loop
const TICK_LIMIT = 50

function isPromise(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && 'then' in value
}

/**
 * This function is for use by unit tests only, it keeps calling `Promise.resolve()`
 * until the function passed to it does not throw. If TICK_LIMIT Promise.resolve calls would
 * be neccesary then it throws the last error.
 */
export const expectAfterSomeTicks = async (
  callback: (() => void) | (() => Promise<void>),
): Promise<void> => {
  let lastError = new Error('expectAfterSomeTicks exceeded TICK_LIMIT')
  for (let i = 0; i < TICK_LIMIT; ++i) {
    try {
      const result = callback()
      if (isPromise(result)) {
        await result
      }
      return
    } catch (e) {
      lastError = e as Error
      await Promise.resolve()
    }
  }
  throw lastError
}

export const expectTimerCountAfterSomeTicks = async (timerCount: number): Promise<void> =>
  expectAfterSomeTicks(() => {
    expect(jest.getTimerCount()).toEqual(timerCount)
  })
