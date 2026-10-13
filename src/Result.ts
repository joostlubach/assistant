/**
 * The outcome of an operation that can fail without that being exceptional, like a request to the app's API.
 */
export type Result<T = void> = ResultOK<T> | ResultError

export const Result = {
  ok,
  error: (message: string): ResultError => ({status: 'error', message}),
}

export interface ResultOK<T> {
  status: 'ok'
  data:   T
}

export interface ResultError {
  status:  'error'
  message: string
}

function ok(): ResultOK<void>
function ok<T>(data: T): ResultOK<T>
function ok(data?: unknown): ResultOK<unknown> {
  return {status: 'ok', data}
}
