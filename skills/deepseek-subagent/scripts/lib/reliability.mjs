export const TRANSIENT_FILE_ERROR_CODES = Object.freeze(['EACCES', 'EBUSY', 'EPERM']);
export const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320, 640]);

const transientFileErrorCodes = new Set(TRANSIENT_FILE_ERROR_CODES);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function retryTransientFileOperation(operation, delays = TRANSIENT_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!transientFileErrorCodes.has(error?.code) || attempt >= delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
}

export function createRecoverableSerialQueue() {
  let tail = Promise.resolve();
  return task => {
    const current = tail.then(task);
    tail = current.catch(() => undefined);
    return current;
  };
}
