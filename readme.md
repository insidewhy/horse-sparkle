# horse-sparkle

[![build status](https://circleci.com/gh/insidewhy/horse-sparkle.png?style=shield)](https://circleci.com/gh/insidewhy/horse-sparkle)
[![Known Vulnerabilities](https://snyk.io/test/github/insidewhy/horse-sparkle/badge.svg)](https://snyk.io/test/github/insidewhy/horse-sparkle)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)

A work queue for JavaScript/TypeScript environments capable of avoiding repetition of work on failure and with bounded memory usage and flexible error handling.

- Allows adding work to a queue to be processed one at a time and in order.
- Puts work to the back of the queue when it fails.
- Resumes work from where it failed rather than having to restart it from scratch (via the power of async iterators).
- Allows limiting the size of the queue to avoid unbounded memory usage:
  - Context is associated with each piece of work, after failure the memory associated with the work is reclaimed but the context can be used to recreate it from scratch.
  - Overflows are consumed from an async generator, the user may recreate the work from the associated context when the queue is empty, throw it away, or perform any other action they want.
- Can customise the behaviour which occurs when a failure is detected:
  - The queue awaits the error handler which can be used to add delays on failure.
  - The consecutive failure count is passed to the error handler which may be used for exponential backoff.

`horse-sparkle` is written in TypeScript and the project includes extensive unit testing.

## Documentation

### Basic usage

It can be useful to create a queue of work, and on error, it may not be great to restart the entire piece of work from the beginning.
`horse-sparkle` enables this pattern:

```typescript
import { yieldErrors, WorkQueue, WorkIterator } from 'horse-sparkle'

async function* doWork(dbId: string): WorkIterator {
  const largeObject = yield* yieldErrors(() => grabLargeObjectFromDatabase(dbId))
  const bigResult = yield* yieldErrors(() => doExpensiveProcessingOnObject(largeObject))
  yield* yieldErrors(() => doFinalProcessingOfBigResult(bigResult))
}

// Here the <string> generic should be the context parameter, we will see how
// this is used later
const queue = new WorkQueue<string>()
queue.start()

function doWorkInTurn(dbId: string): void {
  // The dbId relates to the <string> generic used above
  queue.queueWork(dbId, doWork(dbId))
}
```

The function `yieldErrors` will continuously run the function passed to it until it does not throw an error.
Any thrown error will be yielded by the generator, this causes the work queue to suspend the task.
The work queue will then push the piece of work to the back of the queue and once the work is back at the head of the queue it will resume the task from where it left off e.g.
If `largeObject` was retrieved and `bigResult` was calculated, but then `doFinalProcessingOfBigResult` threw an error, when the work is tried the next time it will not have to calculate `bigResult` again, instead the work will resume with another attempt to call `doFinalProcessingOfBigResult`.

### Removing work from the queue

Certain work should not be retried in all scenarios, for example an unrecoverable error may be detected.
A work item may remove itself from the work queue by yielding `dequeueWork` or throwing `dequeueWork` within a `yieldErrors` callback.

```typescript
import { yieldErrors, dequeueWork, WorkQueue, WorkIterator } from 'horse-sparkle'

async function* doWork(dbId: string): WorkIterator {
  const largeObject = yield* yieldErrors(() => grabLargeObjectFromDatabase(dbId))
  if (largeObject.hasUnrecoverableError) {
    yield dequeueWork
  }
  const bigResult = yield* yieldErrors(() => {
    const processedResult = doExpensiveProcessingOnObject(largeObject)
    if (processedResult.noGood) {
      throw dequeueWork
    }
    return processedResult
  })
  yield* yieldErrors(() => doFinalProcessingOfBigResult(bigResult))
}

const queue = new WorkQueue<string>()
queue.start()

function doWorkInTurn(dbId: string): void {
  queue.queueWork(dbId, doWork(dbId))
}
```

### Error behaviour

In the previous example the work queue will continuously process information without delay.
In many instances this would not be good, for example a database may be down and it would not be desirable to continuously attempt to access it.
This can be solved using the `onError` parameter to `WorkQueue`:

```typescript
const queue = new WorkQueue({
  onError: (error: Error | undefined, consecutiveErrorCount: number): Promise<void> => {
    console.error("Work queue error", error)
    delay(Math.min(2 ** (consecutiveErrorCount - 1) * 100, 400)),
  }
})
```

The return value of the `onError` handler is awaited before processing the next queue item, with the function used above the first delay would be `100ms`, the second would be `200ms` and subsequent delays would be `400ms`.
The `consecutiveErrorCount` is reset to `1` after a piece of work successfully completes, so an error received after a successful completion would cause a `100ms` delay.

### Limiting the queue length

In the first example the object `bigResult` may take up significant amount of memory.
If the size of the work queue was allowed to grow indefinitely and many failures were detected this could result in memory running out.
The `WorkQueue` accepts a `maxQueueLength` parameter for dealing with this.

```typescript
const queue = new WorkQueue({ maxQueueLength: 100 })
```

However it would probably not be useful to completely throw the work away, instead it may be good to reclaim the memory associated with the async iterator and create the work again from scratch later.
The context parameter can then be used to do this, it will be more expensive to repeat the processing but at least the memory usage will have a maximum limit.
To facilitate this `WorkQueue` provides a method `overflows` that returns an async iterator which yields the context related with each piece of work that was thrown out of the queue due to an overflow.
The `waitForSpaceInWorkQueue` method can be used to asynchronously wait for the queue to have space in order to requeue the work if desired.
Repeating the example above:

```typescript
import { yieldErrors, WorkQueue, WorkIterator } from 'horse-sparkle'

async function* doWork(dbId: string): WorkIterator {
  let largeObject: Massive | undefined = yield* yieldErrors(() =>
    grabLargeObjectFromDatabase(dbId)
  )
  const bigResult = yield* yieldErrors(() =>
    doExpensiveProcessingOnObject(largeObject)
  )
  // reclaim memory from largeObject now it is no longer needed
  largeObject = undefined
  yield* yieldErrors(() =>
    doFinalProcessingOfBigResult(bigResult)
  )
}

const queue = new WorkQueue<string>()

function doWorkInTurn(dbId: string): void {
  queue.queueWork(dbId, doWork(dbId))
}

async function* overflowHandler(): Promise<void> => {
  for await (const dbId of queue.overflows()) {
    // this is one suggestion enabled by the API in which the work is eventually
    // pushed to the back of the queue to be resumed from scratch
    await queue.waitForSpaceInWorkQueue()
    queue.queueWork(dbId, doWork(dbId))
  }
}

function startQueue(): Promise<void> {
  return Promise.all([
    queue.start(),
    overflowHandler(),
  ])
}
```

### Stopping the queue

The `stop` method may be called on the queue to stop processing.
This return a promise which resolves after the current piece of asynchronous work performed by the queue succeeds or fails.
The promise returned by the `start` method also resolves at this point, and any async iterator created by the `overflows` method will be completed.
