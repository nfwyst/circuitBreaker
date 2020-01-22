import axios, { AxiosRequestConfig } from 'axios'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { when, gt, lte, ifElse, both } from 'ramda'
import url from 'url'

const cachePath = path.join(
  path.dirname(process.mainModule?.filename || '.'),
  '_cache'
)

interface IdState {
  failures: number,
  coldPeriod: number,
  status: string,
  nextTry: number
}

interface OPTIONS {
  url: string,
  method: string,
  responseType: string,
  timeout?: number
}

enum STATUS {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF = 'HALF'
}

interface State {
  [key: string]: IdState
}

interface Cache {
  [key: string]: any
}

class CirCuitBreaker {
  state: State = {}
  cache: Cache = {}
  constructor(
    public failerThreshold: number = 5,
    public coldPeriod: number = 10,
    public requestTimeout = 60,
  ) { }

  private mkDir = (dirPath: string): void => {
    if (fs.existsSync(dirPath)) return
    this.mkDir(path.dirname(dirPath))
    fs.mkdirSync(dirPath)
  }

  private mkFile = (filePath: string): void => {
    if (fs.existsSync(filePath)) return
    this.mkDir(path.dirname(filePath))
    fs.closeSync(fs.openSync(filePath, 'w'))
  }

  private resetState = (id: string): CirCuitBreaker => {
    this.state[id] = {
      failures: 0,
      coldPeriod: this.coldPeriod,
      status: STATUS.CLOSED,
      nextTry: 0
    }
    return this
  }

  private onSuccess = this.resetState

  private get second(): number {
    return +new Date() / 1000
  }

  private onFailure = (id: string): void => {
    const state = this.state[id]
    state.failures += 1
    const overflow = gt(this.failerThreshold)
    const whenOverflow = when(
      overflow,
      () => {
        Object.assign(state, {
          status: STATUS.OPEN,
          nextTry: this.second + this.coldPeriod
        })
      })
    whenOverflow(state.failures)
  }

  private canRequest = (id: string): boolean => {
    const state = this.state[id]
    if (!state) this.resetState(id)
    const { status, nextTry } = state
    if (status === STATUS.CLOSED) return true
    const coldPeriodPassed = lte(this.second)
    return ifElse(
      coldPeriodPassed,
      () => {
        state.status = STATUS.HALF
        return true
      },
      () => false
    )(nextTry)
  }

  public fetch = async (options: OPTIONS): Promise<any> => {
    const { method, url: URL, responseType, timeout } = options
    const id = `${method}${URL}`
    if (!this.canRequest(id)) return Promise.resolve(null)
    options.timeout = (timeout || this.requestTimeout) * 1000

    const cacheId = crypto.createHash('md5')
      .update(`${method}${url.parse(URL).path}`)
      .digest('hex')

    try {
      const { data } = await axios(options as AxiosRequestConfig)
      this.onSuccess(id)
      ifElse(
        both(
          () => responseType === 'stream',
          () => !!data.pipe
        ),
        () => {
          this.mkDir(cachePath)
          data.pipe(
            fs.createWriteStream(
              path.join(cachePath, cacheId)
            )
          )
        },
        () => this.cache[cacheId] = data
      )
      return Promise.resolve(data)
    } catch {
      this.onFailure(id)
      const filePath = path.join(cachePath, cacheId)
      return ifElse(
        () => fs.existsSync(filePath),
        () => Promise.resolve(fs.createReadStream(filePath)),
        () => Promise.resolve(this.cache[cacheId] || null)
      )
    }
  }
}
