import { yieldErrors } from './yieldErrors'

describe('yieldErrors', () => {
  it('returns an iterator that completes immediately when the callback does not throw', async () => {
    const ret = yieldErrors(() => Promise.resolve())
    expect((await ret.next()).done).toEqual(true)
  })

  it('calls the callback until it completes without error, yielding each error', async () => {
    let callCount = 0
    const ret = yieldErrors(async () => {
      if (++callCount < 3) {
        throw new Error(`error ${callCount}`)
      }
    })
    const result1 = await ret.next()
    expect(result1.done).toEqual(false)
    expect(result1.value).toEqual(new Error('error 1'))
    const result2 = await ret.next()
    expect(result2.done).toEqual(false)
    expect(result2.value).toEqual(new Error('error 2'))
    expect((await ret.next()).done).toEqual(true)
  })

  it('returns the result of the function', async () => {
    let value = 'not this'
    async function* processStuff() {
      value = yield* yieldErrors(() => Promise.resolve('but this'))
    }

    const it = processStuff()
    expect(await it.next()).toHaveProperty('done', true)
    expect(value).toEqual('but this')
  })
})
