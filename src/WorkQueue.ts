export const dequeueWork = Symbol()

export type WorkIterator = AsyncIterator<Error | typeof dequeueWork | undefined, void, void>

export type WorkErrorHandler = (
  error: Error | undefined,
  consecutiveFailureCount: number,
) => Promise<void>

export interface WorkQueueOptions {
  onError?: WorkErrorHandler
  maxQueueLength?: number
}

interface Work<ContextT> {
  context: ContextT
  iterator: WorkIterator
}

/**
 * The work queue class processes multiple pieces of work in order.
 * Any piece of work that fails makes the queue delay the next piece of work
 * and consecutive failures increase the delay exponentially up to a maximum interval.
 * Failed pieces of work are pushed to the back of the queue and resume from the point
 * of failure after they eventually float back to the top of the queue.
 * A piece of work is represented by an AsyncIterator which yields an error whenever one
 * occurs; a piece of work that runs successfully to completion without errors will be an
 * async iterator where the first call to `next()` returns a `done` value of `true`. Each
 * yielded error will be logger by `this.logger`.
 */
export class WorkQueue<ContextT> {
  private readonly onError: WorkErrorHandler | undefined
  private readonly maxQueueLength: number
  private readonly queued: Array<Work<ContextT>> = []
  private running = false
  private listeningForDequeues = false
  private remainingWork: Promise<void> | undefined

  private onPendingWork: Promise<void> | undefined
  private signalPendingWorkOrStop: (() => void) | undefined

  private pendingDequeues: ContextT[] = []
  private signalPendingDequeuesOrStop: (() => void) | undefined

  private signalSpaceInWorkQueue: (() => void) | undefined

  constructor({ onError, maxQueueLength }: WorkQueueOptions = {}) {
    this.onError = onError
    this.maxQueueLength = maxQueueLength ?? Number.MAX_SAFE_INTEGER
  }

  private ensurePendingWorkSignal(): Promise<void> {
    if (!this.onPendingWork) {
      this.onPendingWork = new Promise<void>((resolve) => {
        this.signalPendingWorkOrStop = resolve
      })
    }
    return this.onPendingWork
  }

  // process the queue indefinitely until stop is called, waiting for work when the queue is
  // empty
  private async processQueue(): Promise<void> {
    let consecutiveFailureCount = 1

    while (this.running) {
      if (!this.queued.length) {
        await this.ensurePendingWorkSignal()
        if (!this.running) {
          break
        }
      }

      const nextWork = this.queued.shift()
      if (!nextWork) {
        throw new Error('Theoretically impossible empty queue state detected')
      } else {
        this.onPendingWork = this.signalPendingWorkOrStop = undefined
      }

      if (this.signalSpaceInWorkQueue && this.queued.length < this.maxQueueLength) {
        this.signalSpaceInWorkQueue()
      }

      const { iterator, context } = nextWork
      const { done, value } = await iterator.next()
      if (!this.running) {
        break
      }
      if (!done) {
        if (value !== dequeueWork) {
          if (this.onError) {
            await this.onError(value, consecutiveFailureCount)
          }

          if (!this.running) {
            break
          }
          ++consecutiveFailureCount

          if (this.queued.length < this.maxQueueLength) {
            // thanks to the properties of async iterators the work will resume from where it
            // failed on the next try
            this.queued.push(nextWork)
          } else {
            // the queue overflowed so force the iterator to end and signal that it has been
            // dequeued
            iterator.return?.()
            this.pendingDequeues.push(context)
            this.signalPendingDequeuesOrStop?.()
          }
        }
      } else {
        consecutiveFailureCount = 0
      }
    }
  }

  /**
   * Start processing the queue, return a promise that rejects on when a catastrophic
   * error occurs and resolves after the processing has been stopped via a call to `stop()`
   * The promise returned from this function will remain unresolved even if the queue is emptied,
   * future work added to the queue will cause the processing to resume.
   */
  start(): Promise<void> {
    this.running = true
    this.remainingWork = this.processQueue()
    return this.remainingWork
  }

  /**
   * Queue a new piece of work.
   * This work is represented by an async iterator, it should only yield in case of error.
   * When an error is detected then the code will asynchronously sleep. The first sleep
   * will be for `this.minDelay`ms and will double for every consecutive error
   * up to `this.maxDelay`. Any successful piece of work resets the delay incurred on
   * the next error back to `this.initialDelay`.
   */
  queueWork(context: ContextT, iterator: WorkIterator): void {
    if (!this.running) {
      throw new Error('Cannot queue work when queue has not been started or has been stopped')
    }

    if (this.queued.length < this.maxQueueLength) {
      this.queued.push({ context, iterator })
      this.signalPendingWorkOrStop?.()
    } else {
      // the queue cannot accommodate this new work so force the iterator to end and signal that
      // it has been dequeued
      iterator.return?.()
      this.pendingDequeues.push(context)
      this.signalPendingDequeuesOrStop?.()
    }
  }

  /**
   * Stop processing the queue, the returned promise resolves after the current piece
   * of asynchronous work has finished or immediately if there are no pending asynchronous
   * operations.
   */
  async stop(): Promise<void> {
    if (!this.remainingWork) {
      throw new Error('Cannot call stop() on a queue without first calling start()')
    }
    this.running = false
    this.signalPendingWorkOrStop?.()

    this.pendingDequeues.splice(0)
    this.signalPendingDequeuesOrStop?.()

    const { remainingWork } = this
    this.remainingWork = undefined
    return remainingWork
  }

  /**
   * Return an async generator that yields the context related to work that was dequeued
   * when the queue overflowed.
   */
  async *overflows(): AsyncGenerator<ContextT, void, void> {
    if (this.listeningForDequeues) {
      throw new Error('There may only be a single consumer of the overflows generator')
    }
    this.listeningForDequeues = true

    const getDequeueSignal = () =>
      new Promise<void>((resolve) => {
        this.signalPendingDequeuesOrStop = resolve
      })
    let onPendingDequeue = getDequeueSignal()

    while (this.running) {
      await onPendingDequeue
      onPendingDequeue = getDequeueSignal()

      for (const dequeued of this.pendingDequeues.splice(0)) {
        yield dequeued
      }
    }
    this.signalPendingDequeuesOrStop = undefined
    this.listeningForDequeues = false
  }

  /**
   * Return a promise that resolves when there is space in the work queue for at least one more
   * piece of work.
   */
  async waitForSpaceInWorkQueue(): Promise<void> {
    while (this.queued.length >= this.maxQueueLength) {
      await new Promise<void>((resolve) => {
        this.signalSpaceInWorkQueue = resolve
      })
      this.signalSpaceInWorkQueue = undefined
    }
  }
}
