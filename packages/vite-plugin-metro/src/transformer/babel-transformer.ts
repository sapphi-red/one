/**
 * Copyright (c) 650 Industries (Expo). All rights reserved.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
// A fork of the upstream babel-transformer that uses Expo-specific babel defaults
// and adds support for web and Node.js environments via `isServer` on the Babel caller.
// See:
// * https://github.com/facebook/metro/blob/main/packages/metro-babel-transformer/src/index.js
// * https://github.com/expo/expo/blob/main/packages/%40expo/metro-config/src/babel-transformer.ts
import type { BabelTransformer, BabelTransformerArgs } from 'metro-babel-transformer'
import assert from 'node:assert'

import type { TransformOptions } from './babel-core'
import { loadBabelConfig } from './loadBabelConfig'
import { transformSync } from './transformSync'
import type { ViteCustomTransformOptions } from './types'

export type ExpoBabelCaller = TransformOptions['caller'] & {
  supportsReactCompiler?: boolean
  isReactServer?: boolean
  isHMREnabled?: boolean
  isServer?: boolean
  isNodeModule?: boolean
  preserveEnvVars?: boolean
  isDev?: boolean
  asyncRoutes?: boolean
  baseUrl?: string
  engine?: string
  bundler?: 'metro' | (string & object)
  platform?: string | null
  routerRoot?: string
  projectRoot: string
}

const debug = require('debug')('expo:metro-config:babel-transformer') as typeof console.log

function isCustomTruthy(value: any): boolean {
  return String(value) === 'true'
}

function memoize<T extends (...args: any[]) => any>(fn: T): T {
  const cache = new Map<string, ReturnType<T>>()
  return ((...args: any[]) => {
    const key = JSON.stringify(args)
    if (cache.has(key)) {
      return cache.get(key)
    }
    const result = fn(...args)
    cache.set(key, result)
    return result
  }) as T
}

const memoizeWarning = memoize((message: string) => {
  debug(message)
})

function getBabelCaller({
  filename,
  options,
}: Pick<BabelTransformerArgs, 'filename' | 'options'>): ExpoBabelCaller {
  const isNodeModule = filename.includes('node_modules')
  const isReactServer = options.customTransformOptions?.environment === 'react-server'
  const isGenericServer = options.customTransformOptions?.environment === 'node'
  const isServer = isReactServer || isGenericServer

  const routerRoot =
    typeof options.customTransformOptions?.routerRoot === 'string'
      ? decodeURI(options.customTransformOptions.routerRoot)
      : undefined

  if (routerRoot == null) {
    memoizeWarning(
      'Warning: Missing transform.routerRoot option in Metro bundling request, falling back to `app` as routes directory. This can occur if you bundle without Expo CLI or expo/metro-config.'
    )
  }

  return {
    name: 'metro',
    bundler: 'metro',
    platform: options.platform,
    // Empower the babel preset to know the env it's bundling for.
    // Metro automatically updates the cache to account for the custom transform options.
    isServer,

    // Enable React Server Component rules for AST. The naming maps to the resolver property `--conditions=react-server`.
    isReactServer,

    // The base url to make requests from, used for hosting from non-standard locations.
    baseUrl:
      typeof options.customTransformOptions?.baseUrl === 'string'
        ? decodeURI(options.customTransformOptions.baseUrl)
        : '',

    // Ensure we always use a mostly-valid router root.
    routerRoot: routerRoot ?? 'app',

    isDev: options.dev,

    // This value indicates if the user has disabled the feature or not.
    // Other criteria may still cause the feature to be disabled, but all inputs used are
    // already considered in the cache key.
    preserveEnvVars: isCustomTruthy(options.customTransformOptions?.preserveEnvVars)
      ? true
      : undefined,
    asyncRoutes: isCustomTruthy(options.customTransformOptions?.asyncRoutes) ? true : undefined,
    // Pass the engine to babel so we can automatically transpile for the correct
    // target environment.
    engine: stringOrUndefined(options.customTransformOptions?.engine),

    // Provide the project root for accurately reading the Expo config.
    projectRoot: options.projectRoot,

    isNodeModule,

    isHMREnabled: options.hot,

    // Set the standard Babel flag to disable ESM transformations.
    supportsStaticESM:
      isCustomTruthy(options.customTransformOptions?.optimize) || options.experimentalImportSupport,

    // Enable React compiler support in Babel.
    // TODO: Remove this in the future when compiler is on by default.
    supportsReactCompiler: isCustomTruthy(options.customTransformOptions?.reactCompiler)
      ? true
      : undefined,
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const transform: BabelTransformer['transform'] = ({
  filename,
  src,
  options,
  // `plugins` is used for `functionMapBabelPlugin` from `metro-source-map`. Could make sense to move this to `babel-preset-expo` too.
  plugins,
}: BabelTransformerArgs): ReturnType<BabelTransformer['transform']> => {
  const customOptionsFromVite: ViteCustomTransformOptions = (() => {
    const c: any = options.customTransformOptions?.vite
    if (!c || typeof c !== 'object') {
      throw new Error(
        `[vite-plugin-metro/babel-transformer]: Expect options.customTransformOptions.vite to be an object, but got ${typeof c}.`
      )
    }

    // if (!c.config) {
    //   throw new Error(
    //     `[vite-plugin-metro/babel-transformer]: Expect options.customTransformOptions.vite to be an ViteCustomTransformOptions type, but the config property is missing.`
    //   )
    // }

    return c
  })()

  const babelConfigFromVitePlugin: TransformOptions = customOptionsFromVite.babelConfig || {}

  const OLD_BABEL_ENV = process.env.BABEL_ENV
  process.env.BABEL_ENV = options.dev ? 'development' : process.env.BABEL_ENV || 'production'
  try {
    const babelConfig: TransformOptions = {
      // ES modules require sourceType='module' but OSS may not always want that
      sourceType: 'unambiguous',

      // The output we want from Babel methods
      ast: true,
      code: false,
      // NOTE(EvanBacon): We split the parse/transform steps up to accommodate
      // Hermes parsing, but this defaults to cloning the AST which increases
      // the transformation time by a fair amount.
      // You get this behavior by default when using Babel's `transform` method directly.
      cloneInputAst: false,

      // Options for debugging
      cwd: options.projectRoot,
      filename,
      highlightCode: true,

      ...babelConfigFromVitePlugin,

      ...loadBabelConfig(options),

      babelrc:
        typeof options.enableBabelRCLookup === 'boolean' ? options.enableBabelRCLookup : true,

      plugins: [...(babelConfigFromVitePlugin.plugins || []), ...(plugins as any)],

      // NOTE(EvanBacon): We heavily leverage the caller functionality to mutate the babel config.
      // This compensates for the lack of a format plugin system in Metro. Users can modify the
      // all (most) of the transforms in their local Babel config.
      // This also helps us keep the transform layers small and focused on a single task. We can also use this to
      // ensure the Babel config caching is more accurate.
      // Additionally, by moving everything Babel-related to the Babel preset, it makes it easier for users to reason
      // about the requirements of an Expo project, making it easier to migrate to other transpilers in the future.
      caller: getBabelCaller({ filename, options }),
    }

    const result = transformSync(src, babelConfig, options)

    // The result from `transformFromAstSync` can be null (if the file is ignored)
    if (!result) {
      // BabelTransformer specifies that the `ast` can never be null but
      // the function returns here. Discovered when typing `BabelNode`.
      // @ts-expect-error: see https://github.com/facebook/react-native/blob/401991c3f073bf734ee04f9220751c227d2abd31/packages/react-native-babel-transformer/src/index.js#L220-L224
      return { ast: null }
    }

    assert(result.ast)
    return { ast: result.ast, metadata: result.metadata }
  } finally {
    if (OLD_BABEL_ENV) {
      process.env.BABEL_ENV = OLD_BABEL_ENV
    }
  }
}

const babelTransformer: BabelTransformer = {
  transform,
}

module.exports = babelTransformer
