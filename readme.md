# horse-sparkle

[![build status](https://circleci.com/gh/insidewhy/horse-sparkle.png?style=shield)](https://circleci.com/gh/insidewhy/horse-sparkle)
[![Known Vulnerabilities](https://snyk.io/test/github/insidewhy/horse-sparkle/badge.svg)](https://snyk.io/test/github/insidewhy/horse-sparkle)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)

A flexible and easy to use work queue for JavaScript/TypeScript environments and browsers.

- Queue up multiple pieces of work into a queue.
- Puts work to the back of the queue when it fails.
- Resumes work from where it failed rather than having to restart it (using async generators).
- Allows limiting the size of the queue to avoid unbounded memory usage.
  - Context is associated with each piece of work, after failure the memory associated with the work is reclaimed but the context can be used to recreate it from scratch.
  - Overflows are consumed as an async generator, this can requeue the work when the queue is empty or provide any other programmable behaviour.
- Can customise the behaviour which occurs when a failure is detected, e.g. the processing of the queue may be suspended for a certain time period and this period may increase on consecutive failures.

## Documentation

### Basic usage

It can be useful to create a queue of work, and on error, it may not be great to restart the entire piece of work from the beginning.
`horse-sparkle` enables this pattern:

```typescript
import { yieldErrors, WorkQueue, WorkIterator } from 'horse-sparkle'

async function* doWork(db: string): WorkIterator {
  const largeObject = yield* yieldErrors(() => grabLargeObjectFromDatabase(dbId))
  const bigResult = yield* yieldErrors(() => doExpensiveProcessingOnObject(largeObject))
  yield* yieldErrors(() => doFinalProcessingOfBigResult(bigResult))
}

// Here the <string> generic should be the context parameter, we will see how
// this is used later
const queue = new WorkQueue<string>()
queue.start()

function processDatabaseItem(dbId: string) {
  // The dbId relates to the <string> generic used above
  queue.queueWork(dbId, doWork(dbId))
}
```

The function `yieldErrors` will continuously run the function passed to it until it does not throw an error.
Any thrown error will be yielded by the generator, this causes the work queue to suspend the task.
The work queue will then push the piece of work to the back of the queue and once the work is back at the head of the queue it will resume the task from where it left off e.g.
If `largeObject` was retrieved and `bigResult` was calculated, but then `doFinalProcessingOfBigResult` threw an error, when the work is tried the next time it will not have to calculate `bigResult` again, instead the work will resume with another attempt to call `doFinalProcessingOfBigResult`.

### Error behaviour

In the previous example the work queue will continuously process information without delay.
In many instances this would not be good, for example a database may be down and it would not be desirable to continuously attempt to access it.
This can be solved using the `onError` parameter to `WorkQueue`:

```typescript
const queue = new WorkQueue({
  onError: (error: Error | undefined, consecutiveErrorCount: number) =>
    delay(Math.min(2 ** (consecutiveErrorCount - 1) * 100, 400)),
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

However it would probably not be useful to completely throw the work away, instead we may wish to queue the work again later but throw away the memory until it is queued again.
The context parameter can then be used to restart the job from scratch, it will be more expensive to repeat the processing but at least the memory usage will be significantly less.
To facilitate this `WorkQueue` provides a method `overflows` that returns a generator which yields the context related with each piece of work that was thrown out of the queue due to an overflow.
The `waitForSpaceInWorkQueue` method can be used to asynchronously wait for the queue to have space in order to requeue the work if desired.
Repeating the example above:

```typescript
import { yieldErrors, WorkQueue, WorkIterator } from 'horse-sparkle'

async function* doWork(db: string): WorkIterator {
  const largeObject = yield* yieldErrors(() =>
    grabLargeObjectFromDatabase(dbId)
  )
  const bigResult = yield* yieldErrors(() =>
    doExpensiveProcessingOnObject(largeObject)
  )
  yield* yieldErrors(() =>
    doFinalProcessingOfBigResult(bigResult)
  )
}


// Here the <string> generic should be the context parameter, we will see how
// this is used later
const queue = new WorkQueue<string>()

function processDatabaseItem(dbId: string) {
  // The dbId relates to the <string> generic used above
  queue.queueWork(dbId, doWork(dbId))
}

async function* onOverflow(): Promise<void> => {
  for await (const dbId of queue.overflows()) {
    await queue.waitForSpaceInWorkQueue()
    // other suggestions include maintaining a Map of failure counts against
    // dbId in order to decide whether to permanently throw out work that has
    // failed too many times
    queue.queueWork(dbId, doWork(dbId))
  }
}

function startQueue(): Promise<void> {
  return Promise.all([
    queue.start(),
  ])
}
```

### Stopping the queue

The `stop` method may be called on the queue to stop processing.
This return a promise which resolves after the current piece of asynchronous work performed by the queue succeeds or fails.
The promise returned by the `start` method also resolves at this point, and an async generator created by the `overflows` method will be completed.
