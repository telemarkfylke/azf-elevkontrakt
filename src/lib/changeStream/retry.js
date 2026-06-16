const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {() => Promise<any>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number }} [opts]
 */
const retry = async (fn, opts = {}) => {
  const { maxAttempts = 3, baseDelayMs = 500 } = opts
  let lastError
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, attempt))
      }
    }
  }
  throw lastError
}

module.exports = { retry }
