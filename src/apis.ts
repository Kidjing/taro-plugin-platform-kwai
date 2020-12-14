import {
  queryToJson,
  getUniqueKey,
  cacheDataSet,
  cacheDataGet
} from '@tarojs/shared'
import { _onAndSyncApis, _noPromiseApis, _otherApis } from './apis-list'

declare const ks: any
declare const getCurrentPages: () => any
declare const getApp: () => any

interface ITaro {
  onAndSyncApis: Set<string>
  noPromiseApis: Set<string>
  otherApis: Set<string>
  [propName: string]: any
}

const RequestQueue = {
  MAX_REQUEST: 5,
  queue: [],
  request (options) {
    this.push(options)
    // 返回request task
    return this.run()
  },

  push (options) {
    this.queue.push(options)
  },

  run () {
    if (!this.queue.length) {
      return
    }
    if (this.queue.length <= this.MAX_REQUEST) {
      const options = this.queue.shift()
      const completeFn = options.complete
      options.complete = () => {
        completeFn && completeFn.apply(options, [...arguments])
        this.run()
      }
      return ks.request(options)
    }
  }
}

function taroInterceptor (chain) {
  return request(chain.requestParams)
}

function request (options) {
  options = options || {}
  if (typeof options === 'string') {
    options = {
      url: options
    }
  }
  const originSuccess = options.success
  const originFail = options.fail
  const originComplete = options.complete
  let requestTask
  const p: any = new Promise((resolve, reject) => {
    options.success = res => {
      originSuccess && originSuccess(res)
      resolve(res)
    }
    options.fail = res => {
      originFail && originFail(res)
      reject(res)
    }

    options.complete = res => {
      originComplete && originComplete(res)
    }

    requestTask = RequestQueue.request(options)
  })
  p.abort = (cb) => {
    cb && cb()
    if (requestTask) {
      requestTask.abort()
    }
    return p
  }
  return p
}

function processApis (taro: ITaro) {
  const onAndSyncApis = new Set([...taro.onAndSyncApis, ..._onAndSyncApis])
  const noPromiseApis = new Set([...taro.noPromiseApis, ..._noPromiseApis])
  const otherApis = new Set([...taro.otherApis, ..._otherApis])
  const apis = [...onAndSyncApis, ...noPromiseApis, ...otherApis]
  const preloadPrivateKey = '__preload_'
  const preloadInitedComponent = '$preloadComponent'
  apis.forEach(key => {
    if (!(key in ks)) {
      taro[key] = () => {
        console.warn(`快手小程序暂不支持 ${key}`)
      }
      return
    }
    if (otherApis.has(key)) {
      taro[key] = (options, ...args) => {
        options = options || {}
        let task: any = null
        const obj = Object.assign({}, options)
        if (typeof options === 'string') {
          if (args.length) {
            return ks[key](options, ...args)
          }
          return ks[key](options)
        }

        if (key === 'navigateTo' || key === 'redirectTo' || key === 'switchTab') {
          let url = obj.url ? obj.url.replace(/^\//, '') : ''
          if (url.indexOf('?') > -1) url = url.split('?')[0]

          const Component = cacheDataGet(url)
          if (Component) {
            const component = new Component()
            if (component.componentWillPreload) {
              const cacheKey = getUniqueKey()
              const MarkIndex = obj.url.indexOf('?')
              const hasMark = MarkIndex > -1
              const urlQueryStr = hasMark ? obj.url.substring(MarkIndex + 1, obj.url.length) : ''
              const params = queryToJson(urlQueryStr)
              obj.url += (hasMark ? '&' : '?') + `${preloadPrivateKey}=${cacheKey}`
              cacheDataSet(cacheKey, component.componentWillPreload(params))
              cacheDataSet(preloadInitedComponent, component)
            }
          }
        }

        const p: any = new Promise((resolve, reject) => {
          ['fail', 'success', 'complete'].forEach((k) => {
            obj[k] = (res) => {
              options[k] && options[k](res)
              if (k === 'success') {
                if (key === 'connectSocket') {
                  resolve(
                    Promise.resolve().then(() => Object.assign(task, res))
                  )
                } else {
                  resolve(res)
                }
              } else if (k === 'fail') {
                reject(res)
              }
            }
          })
          if (args.length) {
            task = ks[key](obj, ...args)
          } else {
            task = ks[key](obj)
          }
        })
        if (key === 'uploadFile' || key === 'downloadFile') {
          p.progress = cb => {
            if (task) {
              task.onProgressUpdate(cb)
            }
            return p
          }
          p.abort = cb => {
            cb && cb()
            if (task) {
              task.abort()
            }
            return p
          }
        }
        return p
      }
    } else {
      taro[key] = (...args) => {
        const argsLen = args.length
        const newArgs = args.concat()
        const lastArg = newArgs[argsLen - 1]
        if (lastArg && lastArg.isTaroComponent && lastArg.$scope) {
          newArgs.splice(argsLen - 1, 1, lastArg.$scope)
        }
        return ks[key].apply(ks, newArgs)
      }
    }
  })
}

function pxTransform (size) {
  const {
    designWidth = 750,
    deviceRatio = {
      640: 2.34 / 2,
      750: 1,
      828: 1.81 / 2
    }
  } = this.config || {}
  if (!(designWidth in deviceRatio)) {
    throw new Error(`deviceRatio 配置中不存在 ${designWidth} 的设置！`)
  }
  return (parseInt(size, 10) * deviceRatio[designWidth]) + 'rpx'
}

export function initNativeApi (taro) {
  processApis(taro)
  const link = new taro.Link(taroInterceptor)
  taro.request = link.request.bind(link)
  taro.addInterceptor = link.addInterceptor.bind(link)
  taro.cleanInterceptors = link.cleanInterceptors.bind(link)
  taro.getCurrentPages = getCurrentPages
  taro.getApp = getApp
  taro.initPxTransform = taro.initPxTransform.bind(taro)
  taro.pxTransform = pxTransform.bind(taro)
  taro.env = ks.env
}
