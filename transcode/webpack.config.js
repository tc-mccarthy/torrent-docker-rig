const path = require('path');
const ESLintLoader = require('eslint-webpack-plugin');
const NodemonPlugin = require('nodemon-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const pure_funcs = [];

if (process.env.ENV === 'prod') {
  pure_funcs.push('console.log');
}

module.exports = {
  entry: ['./'],
  target: 'node',
  output: {
    filename: 'server.js',
    path: path.resolve(__dirname, 'bin'),
    publicPath: '/bin/'
  },
  externals: [{ express: "require('express')" }],
  devtool: 'inline-source-map',
  devServer: {
    port: 3888, // default: 8080
    open: true, // open page in browser
    static: {
      directory: path.join(__dirname, 'public')
    }
  },
  module: {
    rules: [
      {
        test: /\.(m|c)?(js)$/,
        exclude: /node_modules/,
        use: ['babel-loader']
      }
    ]
  },
  optimization: {
    minimize: process.env.ENV !== 'local',
    minimizer: [
      new TerserPlugin({
        test: /\.(m|c)?(js)$/,
        extractComments: true,
        parallel: true,
        terserOptions: {
          compress: {
            pure_funcs
          }
        }
      })
    ]
  },
  plugins: [
    new ESLintLoader({
      fix: true,
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      configType: 'flat'
    }),
    new NodemonPlugin({
      // If using more than one entry, you can specify
      // which output file will be restarted.
      script: './bin/server.js',

      // What to watch.
      watch: path.resolve('./bin'),

      // Arguments to pass to the script being watched.
      args: ['demo'],

      // Node arguments.
      // nodeArgs: ['--debug=9222'],

      // Files to ignore.
      ignore: ['*.js.map'],

      // Extensions to watch.
      ext: 'js,njk,json,mjs,cjs',

      // Unlike the cli option, delay here is in milliseconds (also note that it's a string).
      // Here's 1 second delay:
      delay: '1000',

      // Detailed log.
      verbose: true,

      // Environment variables to pass to the script to be restarted
      env: {
        NODE_ENV: 'development'
      },

      nodemonConfig: {
        legacyWatch: true
      }
    })
  ],
  resolve: {
    extensions: ['*', '.js', '.mjs', '.cjs']
  }
};
