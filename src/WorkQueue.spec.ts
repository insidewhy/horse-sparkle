import delay from 'delay'

import { WorkErrorHandler, WorkIterator, WorkQueue, dequeueWork } from './WorkQueue'
import { expectAfterSomeTicks, expectTimerCountAfterSomeTicks } from './expectAfterSomeTicks'

describe('WorkQueue', () => {
  const buildWorkQueue = (
    maxQueueLength?: number,
    onError?: WorkErrorHandler,
  ): WorkQueue<string> => new WorkQueue({ onError, maxQueueLength })

  const expectNotResolved = async (promise: Promise<void>) => {
    const nextTickResult = Symbol()
    const nextTickPromise = async () => {
      await Promise.resolve()
      return nextTickResult
    }
    await expect(Promise.race([nextTickPromise(), promise])).resolves.toEqual(nextTickResult)
  }

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('processes the first piece of work', async () => {
    const queue = buildWorkQueue()
    const started = queue.start()
    let signal = 1

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        await Promise.resolve()
        ++signal
      })(),
    )

    await expectAfterSomeTicks(() => {
      expect(signal).toEqual(2)
    })

    await expectNotResolved(started)
    await queue.stop()
    await started
  })

  it('queues two pieces of work and runs them in order', async () => {
    const queue = buildWorkQueue()
    const started = queue.start()
    const signals: number[] = []

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        await delay(3)
        signals.push(1)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        await delay(1)
        signals.push(2)
      })(),
    )

    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(3)
    await Promise.resolve()
    expect(signals).toEqual([1])

    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signals).toEqual([1, 2])

    await queue.stop()
    await started
  })

  it('allows work to dequeue itself by yielding dequeueWork', async () => {
    const queue = buildWorkQueue()
    const started = queue.start()
    const signals: number[] = []

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        await delay(1)
        signals.push(1)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        await delay(1)
        yield dequeueWork
        signals.push(2)
      })(),
    )
    queue.queueWork(
      'c',
      (async function* (): WorkIterator {
        await delay(1)
        signals.push(3)
      })(),
    )

    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signals).toEqual([1])

    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signals).toEqual([1])

    // ensure processing continues after dequeue
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signals).toEqual([1, 3])

    // ensure dequeued item wasn't added to back of the queue, if it was
    // then it would be scheduled before the following piece of work:
    queue.queueWork(
      'd',
      (async function* (): WorkIterator {
        await delay(1)
        signals.push(4)
      })(),
    )
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signals).toEqual([1, 3, 4])

    await queue.stop()
    await started
  })

  it('resumes processing when a new piece of work is added after the queue has been drained', async () => {
    const queue = buildWorkQueue()
    const started = queue.start()
    let signal = 0

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        await delay(3)
        signal = 1
      })(),
    )

    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(3)
    await Promise.resolve()
    await expectNotResolved(started)

    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        await delay(1)
        signal = 2
      })(),
    )
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    expect(signal).toEqual(2)

    await queue.stop()
    await started
  })

  it('interrupts work when stop method is called', async () => {
    const queue = buildWorkQueue()
    queue.start()
    const signals: number[] = []

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        signals.push(1)
        await delay(3)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
      })(),
    )

    await Promise.resolve()
    expect(signals).toEqual([1])
    jest.runAllTimers()
    await queue.stop()

    // ensure second async iterator does not run
    await Promise.resolve()
    expect(signals).toEqual([1])
  })

  it('delays according to promise returned by error handler and puts work to back of queue on failure then resumes work from point of failure when returning to the queued work', async () => {
    const queue = buildWorkQueue(undefined, () => delay(100))
    queue.start()
    const signals: number[] = []

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        // this push is used to ensure that work resumes from the point of failure
        signals.push(1)
        yield new Error('fail') // failure!
        signals.push(3)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
      })(),
    )

    await Promise.resolve()
    expect(signals).toEqual([1])

    await expectTimerCountAfterSomeTicks(1)

    jest.advanceTimersByTime(50)
    // ensure the queue is still in the delay
    await Promise.resolve()
    expect(signals).toEqual([1])

    // advance past delay
    jest.advanceTimersByTime(50)
    await Promise.resolve()
    expect(signals).toEqual([1, 2])

    // ensure the task was pushed to the back of the queue and resumed from where it
    // errored
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3])

    await queue.stop()
  })

  // the next two tests could be a lot simpler but they demonstrate a common use of the
  // error callback, expontentially increasing delays on failure
  it('passes consecutive failure count to error handler', async () => {
    const queue = buildWorkQueue(undefined, (_, count) =>
      delay(Math.min(2 ** (count - 1) * 100, 400)),
    )
    queue.start()
    const signals: number[] = []

    // note that each piece of work jumps to the back of the queue after it fails so the tasks
    // interleave
    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        signals.push(1)
        yield // fail 1 -> 100ms delay
        signals.push(4)
        yield // fail 4 -> also 400ms delay
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
        yield // fail 2 -> 200ms delay
        signals.push(5)
      })(),
    )
    queue.queueWork(
      'c',
      (async function* (): WorkIterator {
        signals.push(3)
        yield // fail 3 -> 400ms delay
      })(),
    )

    await Promise.resolve()
    expect(signals).toEqual([1])

    // reach first delay
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    expect(signals).toEqual([1, 2])

    // +100 is half way through the next delay
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    expect(signals).toEqual([1, 2])

    // reach second delay
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3])

    // +200 is half way through the next delay
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3])

    // reach third delay
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4])

    // the max delay was reached above so +200 is half way through the next delay
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4])

    // finish work after fourth error
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4, 5])

    await queue.stop()
  })

  it('resets consecutive failure count after a piece of work succeeds', async () => {
    const queue = buildWorkQueue(undefined, (_, count) =>
      delay(Math.min(2 ** (count - 1) * 100, 400)),
    )
    queue.start()
    const signals: number[] = []

    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        signals.push(1)
        yield // fail 1 -> 100ms delay
        signals.push(4)
        yield // fail 3 -> after success so back to 100ms delay
        signals.push(6)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
        yield // fail 2 -> 200ms delay
        signals.push(5)
        yield // fail 4 -> 200ms delay following 100ms delay from fail 3
        signals.push(7)
      })(),
    )
    queue.queueWork(
      'c',
      (async function* (): WorkIterator {
        signals.push(3)
        // the third task completes which resets the delay back to 100 and
        // resume the first task right after
      })(),
    )

    await Promise.resolve()
    expect(signals).toEqual([1])

    // reach first delay
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    expect(signals).toEqual([1, 2])

    // reach second delay, after this delay the third async iterator completes...
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3])
    // ...so the first async iterator resumes in the tick after the third completes
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4])

    // reach third delay, here the delay was reset back to 100
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4, 5])

    // finish work after fourth error
    await expectTimerCountAfterSomeTicks(1)
    jest.advanceTimersByTime(200)
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4, 5, 6])
    // the first async iterator completed above so the second task will run in the next tick
    await Promise.resolve()
    expect(signals).toEqual([1, 2, 3, 4, 5, 6, 7])

    await queue.stop()
  })

  it('yields dequeued context when trying to push work beyond the queue size', async () => {
    const queue = buildWorkQueue(2)
    queue.start()

    const overflows: string[] = []
    const onOverflow = async (): Promise<void> => {
      for await (const context of queue.overflows()) {
        overflows.push(context)
      }
    }
    const overflowPromise = onOverflow()

    const signals: number[] = []
    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        signals.push(1)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
      })(),
    )
    queue.queueWork(
      'c',
      (async function* (): WorkIterator {
        signals.push(3)
      })(),
    )

    await expectAfterSomeTicks(() => {
      expect(overflows).toEqual(['c'])
    })
    expect(signals).toEqual([1, 2])
    await queue.stop()
    // it should finish after calling stop()
    await overflowPromise
  })

  it('yields dequeued context for requeued work that would exceed the queue limit', async () => {
    const queue = buildWorkQueue(2)
    queue.start()

    const overflows: string[] = []
    const onOverflow = async (): Promise<void> => {
      for await (const context of queue.overflows()) {
        overflows.push(context)
      }
    }
    const overflowPromise = onOverflow()

    const signals: number[] = []
    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        // when this occurs this piece of work has been dequeue leading to a queue size of 0
        await delay(100)
        // at this point the next two items have been pushed (leading to a queue size of two)
        // attempting to requeue this would exceed the queue size so it is yielded as a dequeue
        yield
        signals.push(3) // this never happens
      })(),
    )

    await expectTimerCountAfterSomeTicks(1)

    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(1)
      })(),
    )
    queue.queueWork(
      'c',
      (async function* (): WorkIterator {
        signals.push(2)
      })(),
    )

    // advance past the delay in the first work item
    jest.advanceTimersByTime(100)

    await expectAfterSomeTicks(() => {
      expect(overflows).toEqual(['a'])
    })
    expect(signals).toEqual([1, 2])

    await queue.stop()
    await overflowPromise
  })

  it('waitForSpaceInWorkQueue resolves immediately when there is sufficient space', async () => {
    const queue = buildWorkQueue(2)
    queue.start()
    await expect(queue.waitForSpaceInWorkQueue()).resolves.toEqual(undefined)
  })

  it('waitForSpaceInWorkQueue resolves after the work queue has sufficient space', async () => {
    const queue = buildWorkQueue(2)
    queue.start()

    const signals: number[] = []
    queue.queueWork(
      'a',
      (async function* (): WorkIterator {
        await delay(100)
        signals.push(1)
      })(),
    )
    queue.queueWork(
      'b',
      (async function* (): WorkIterator {
        signals.push(2)
      })(),
    )

    const waitForSpace = queue.waitForSpaceInWorkQueue()
    await expectNotResolved(waitForSpace)

    await expectTimerCountAfterSomeTicks(1)
    await expect(waitForSpace).resolves.toEqual(undefined)

    jest.advanceTimersByTime(100)
    await expectAfterSomeTicks(() => {
      expect(signals).toEqual([1, 2])
    })
    await queue.stop()
  })

  describe('supports combination of overflows and waitForSpaceInWorkQueue', () => {
    it('to allow recreating work from context when work is pushed that exceeds queue limit', async () => {
      const queue = buildWorkQueue(2)
      queue.start()

      const signals: string[] = []

      const onOverflow = async (): Promise<void> => {
        for await (const context of queue.overflows()) {
          await queue.waitForSpaceInWorkQueue()
          queue.queueWork(
            context,
            (async function* (): WorkIterator {
              signals.push(context)
            })(),
          )
        }
      }
      const overflowPromise = onOverflow()

      queue.queueWork(
        'a',
        (async function* (): WorkIterator {
          signals.push('a')
        })(),
      )
      queue.queueWork(
        'b',
        (async function* (): WorkIterator {
          signals.push('b')
        })(),
      )
      queue.queueWork(
        'c',
        (async function* (): WorkIterator {
          // this never happens because the work is dequeue then replaced
          signals.push('never')
        })(),
      )
      queue.queueWork(
        'd',
        (async function* (): WorkIterator {
          signals.push('never')
        })(),
      )

      await expectAfterSomeTicks(() => {
        expect(signals).toEqual(['a', 'b', 'c', 'd'])
      })
      await queue.stop()
      await overflowPromise
    })

    it('to allow recreating work from context when queue overflows', async () => {
      const queue = buildWorkQueue(2)
      queue.start()

      const signals: string[] = []

      const onOverflow = async (): Promise<void> => {
        for await (const context of queue.overflows()) {
          await queue.waitForSpaceInWorkQueue()
          queue.queueWork(
            context,
            (async function* (): WorkIterator {
              signals.push(context)
            })(),
          )
        }
      }
      const overflowPromise = onOverflow()

      queue.queueWork(
        'a',
        (async function* (): WorkIterator {
          // when this occurs this piece of work has been dequeue leading to a queue size of 0
          await delay(100)
          // at this point the next two items have been pushed (leading to a queue size of two)
          // attempting to requeue this would exceed the queue size so it is yielded as a dequeue
          yield
          // this never happens because the work is dequeue then replaced
          signals.push('never')
        })(),
      )

      await expectTimerCountAfterSomeTicks(1)

      queue.queueWork(
        'b',
        (async function* (): WorkIterator {
          signals.push('b')
        })(),
      )
      queue.queueWork(
        'c',
        (async function* (): WorkIterator {
          signals.push('c')
        })(),
      )

      // advance past the delay in the first work item
      jest.advanceTimersByTime(100)

      await expectAfterSomeTicks(() => {
        expect(signals).toEqual(['b', 'c', 'a'])
      })

      await queue.stop()
      await overflowPromise
    })
  })
})
