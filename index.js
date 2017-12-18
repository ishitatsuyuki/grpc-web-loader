const Promise = require('bluebird')
const os = require('os')
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const which = require('which')
const rimraf = require('rimraf')
const loaderUtils = require('loader-utils')

Promise.promisifyAll(childProcess)
Promise.promisifyAll(fs)

const whichAsync = Promise.promisify(which)
const rimrafAsync = Promise.promisify(rimraf)
const tmpdirPrefix = path.join(os.tmpdir(), 'grpc-web-loader-')

const defaultOptions = {
  kind: 'grpcService'
}

function stringifyLoaders (loaders) {
  return loaders
    .map(
      obj =>
        obj && typeof obj === 'object' && typeof obj.loader === 'string'
          ? obj.loader +
          (obj.options ? '?' + JSON.stringify(obj.options) : '')
          : obj
    )
    .join('!')
}

function createTmpDir () {
  return fs.mkdtempAsync(tmpdirPrefix)
}

function removeTmpDir (dir) {
  return rimrafAsync(dir)
}

async function processBase (loaderContext, options, compileArg, postProc) {
  const dir = await createTmpDir()
  const protoc = await whichAsync('protoc')
  const jsService = await whichAsync('protoc-gen-js_service')
  const basePath = path.resolve(options.basePath)
  try {
    const [stdout, stderr] = await childProcess.execFileAsync(
      protoc, [
        `--plugin=protoc-gen-js_service=${jsService}`,
        `--proto_path=${basePath}`,
        compileArg + dir,
        loaderContext.resourcePath,
      ], {
        encoding: 'utf8'
      })
    if (stderr) loaderContext.emitError(stderr)

    const relPath = path.relative(basePath, loaderContext.resourcePath).replace(/\.[^/.]+$/, '')
    return await postProc(dir, relPath)
  } finally {
    await removeTmpDir(dir)
  }
}

function processProtoJs (loaderContext, options) {
  return processBase(loaderContext, options, '--js_out=import_style=commonjs,binary:', (dir, relPath) =>
    fs.readFileAsync(path.join(dir, relPath + '_pb.js'))
  )
}

function processGrpcService (loaderContext, options) {
  return processBase(loaderContext, options, '--js_service_out=', async function (dir, relPath) {
    const out = await fs.readFileAsync(path.join(dir, relPath + '_pb_service.js'), {encoding: 'utf8'})
    const pathDiff = '"' + path.join(path.relative(path.dirname(relPath), ''), relPath + '_pb').replace(/\\/g, '/') + '"'
	const dependencyUri = JSON.stringify(stringifyLoaders([{
      loader: 'grpc-web-loader',
      options: Object.assign({}, options, {kind: 'proto'})
    }, loaderContext.resourcePath]))
    return out.replace(pathDiff, dependencyUri) + `Object.assign(module.exports, require(${dependencyUri}))\n`
  })
}

module.exports = async function (source) {
  const options = Object.assign({},
    defaultOptions,
    loaderUtils.getOptions(this),
  )
  const callback = this.async()

  try {
    const mapping = {
      proto: processProtoJs,
      grpcService: processGrpcService
    }
    const result = await mapping[options.kind](this, options)
    return callback(null, result)
  } catch (err) {
    return callback(err)
  }
}
