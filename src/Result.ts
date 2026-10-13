/**
 * The outcome of an operation that can fail without that being exceptional, like a request to the app's API.
 */
export type Result<T = void> = ResultOK<T> | ResultError

export const Result = {
  ok:    <T = void>(...[data]: [T] extends [void] ? [] : [T]): ResultOK<T> => ({status: 'ok', data: data as T}),
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
